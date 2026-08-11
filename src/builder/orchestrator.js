// Owner-to-Builder end-to-end orchestration glue (Stage 1).
// Uses existing Builder Core components only. No second provider. No redesign.
// Worker never self-certifies. Authority remains verifier + optional Codex.

import {
  EVENT_TYPE,
  FAILURE_CLASS,
  RUN_STATUS,
  TASK_STATUS,
  VERIFICATION_RESULT,
  REVIEW_STATUS,
  assertCommitSha,
} from './contracts.js';
import { BuilderCoreError } from './errors.js';
import { PROVIDER_STATUS } from './worker-provider.js';
import { createCodexReviewInvoker } from './codex-review.js';
import { createGhLandingClient } from './github-landing.js';
import { workerApprovedTools } from './tool-policy.js';
import {
  waitForExactCandidateCi,
  CI_WAIT_OUTCOME,
  detectAwaitingCi,
} from './ci-wait.js';

export const ORCHESTRATION_DECISION = Object.freeze({
  DONE: 'DONE',
  RETRY: 'RETRY',
  BLOCKED: 'BLOCKED',
  NEEDS_OWNER: 'NEEDS_OWNER',
});

export class OrchestratorError extends Error {
  constructor(message, code = 'ORCHESTRATOR_ERROR') {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function extractCandidateLanding(evidence = {}) {
  const git = evidence.git && typeof evidence.git === 'object' ? evidence.git : {};
  // Cursor SDK cloud shape: git.branches[{ repoUrl, branch?, prUrl? }]
  const branchEntry = Array.isArray(git.branches) ? git.branches[0] : null;
  const branch =
    branchEntry?.branch ||
    git.branchName ||
    git.branch_name ||
    git.branch ||
    git.ref ||
    evidence.branch ||
    evidence.head_branch ||
    null;
  const commit_sha =
    git.commitSha ||
    git.commit_sha ||
    git.headSha ||
    git.head_sha ||
    git.sha ||
    evidence.commit_sha ||
    evidence.head_sha ||
    null;
  let pr_url =
    branchEntry?.prUrl ||
    git.prUrl ||
    git.pr_url ||
    git.pullRequestUrl ||
    evidence.pr_url ||
    null;
  let pr_number =
    git.prNumber ||
    git.pr_number ||
    git.pullRequestNumber ||
    evidence.pr_number ||
    null;
  if (pr_number == null && typeof pr_url === 'string') {
    const m = pr_url.match(/\/pull\/(\d+)/);
    if (m) pr_number = Number(m[1]);
  }
  return {
    branch: branch ? String(branch).replace(/^refs\/heads\//, '') : null,
    commit_sha: commit_sha ? String(commit_sha) : null,
    pr_number: pr_number == null ? null : Number(pr_number),
    pr_url: pr_url ? String(pr_url) : null,
  };
}

/**
 * Bind exact commit_sha from GitHub landing truth when worker evidence has
 * branch/PR but not SHA (Cursor SDK git.branches omits SHA).
 */
export async function resolveLandingSha(landing, githubClient) {
  if (!landing) return landing;
  if (landing.commit_sha) {
    return { ...landing, commit_sha: assertCommitSha(landing.commit_sha) };
  }
  if (!githubClient) {
    throw new OrchestratorError(
      'landing missing commit_sha and githubClient unavailable',
      'MISSING_LANDING_SHA'
    );
  }
  if (landing.pr_number != null) {
    const pr = await githubClient.getPullRequest(landing.pr_number);
    if (!pr?.head_sha) {
      throw new OrchestratorError(
        `PR #${landing.pr_number} missing head_sha`,
        'MISSING_LANDING_SHA'
      );
    }
    if (landing.branch && pr.head_ref && pr.head_ref !== landing.branch) {
      throw new OrchestratorError(
        `PR head_ref ${pr.head_ref} != worker branch ${landing.branch}`,
        'PR_BRANCH_MISMATCH'
      );
    }
    return {
      ...landing,
      branch: landing.branch || pr.head_ref,
      commit_sha: assertCommitSha(pr.head_sha),
      pr_url: landing.pr_url || pr.html_url,
      pr_number: pr.number,
    };
  }
  if (landing.branch && typeof githubClient.getBranchHeadSha === 'function') {
    const sha = await githubClient.getBranchHeadSha(landing.branch);
    return {
      ...landing,
      commit_sha: assertCommitSha(sha),
    };
  }
  throw new OrchestratorError(
    'cannot resolve exact commit_sha from branch/PR landing evidence',
    'MISSING_LANDING_SHA'
  );
}

function buildWorkerPrompt(task, { owner_prompt = null } = {}) {
  if (owner_prompt && String(owner_prompt).trim()) return String(owner_prompt).trim();
  const tools = workerApprovedTools(task);
  return [
    'You are the Stage-1 coding worker for JARVIS Builder Core.',
    'Implement ONLY the locked owner intent below.',
    'Do not mark the task DONE. Do not weaken tests or acceptance.',
    'Do not use business/production credentials.',
    '',
    `task_id: ${task.task_id}`,
    `intent: ${task.intent}`,
    `acceptance_ref: ${task.acceptance_ref}`,
    `allowed_paths: ${JSON.stringify(task.allowed_paths)}`,
    `allowed_tool_manifest: ${JSON.stringify(tools.allowed_tool_manifest)}`,
    `review_required: ${Boolean(task.review_required)}`,
  ].join('\n');
}

async function waitForWorkerTerminal(core, factoryRunId, {
  poll_ms = 2000,
  timeout_ms = 15 * 60 * 1000,
} = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout_ms) {
    last = await core.refreshWorkerStatus(factoryRunId);
    const status = last.run.status;
    if (
      [
        RUN_STATUS.SUCCEEDED,
        RUN_STATUS.FAILED,
        RUN_STATUS.CANCELLED,
        RUN_STATUS.STALE,
      ].includes(status)
    ) {
      return last;
    }
    // Also treat provider FINISHED mapped to SUCCEEDED.
    if (last.provider_result?.provider_status === PROVIDER_STATUS.FINISHED) {
      return last;
    }
    await sleep(poll_ms);
  }
  throw new OrchestratorError(
    `worker wait timed out for ${factoryRunId}`,
    'WORKER_TIMEOUT'
  );
}

async function collectLanding(core, factoryRunId) {
  const collected = await core.collectCodingWorker(factoryRunId, { wait: true });
  const landing = extractCandidateLanding(collected.run.evidence || {});
  return { collected, landing };
}

async function registerAndVerify(core, {
  task,
  run,
  landing,
  githubClient,
  runTaskTests,
  runBuildChecks,
  ci_poll_ms = 5000,
  ci_timeout_ms = 20 * 60 * 1000,
  sleepFn = sleep,
  onCiWait = null,
}) {
  if (!landing.branch && landing.pr_number == null) {
    throw new OrchestratorError(
      'worker collect missing branch/PR landing evidence',
      'MISSING_LANDING'
    );
  }
  let resolved = await resolveLandingSha(landing, githubClient);
  if (!resolved.branch || !resolved.commit_sha) {
    throw new OrchestratorError(
      'unable to bind exact branch + commit_sha from landing evidence',
      'MISSING_LANDING'
    );
  }

  let candidate = null;
  let ciWait = null;
  const maxRebinds = 2;
  for (let rebind = 0; rebind <= maxRebinds; rebind += 1) {
    const sha = assertCommitSha(resolved.commit_sha);
    candidate = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: resolved.branch,
      commit_sha: sha,
      pr_number: resolved.pr_number,
      pr_url: resolved.pr_url,
      evidence_at: nowIso(),
    });

    if (githubClient) {
      await core.refreshCandidateLanding(candidate.candidate_id, githubClient);
      ciWait = await waitForExactCandidateCi(core, {
        candidate_id: candidate.candidate_id,
        githubClient,
        poll_ms: ci_poll_ms,
        timeout_ms: ci_timeout_ms,
        sleepFn,
      });
      if (typeof onCiWait === 'function') onCiWait(ciWait);

      if (ciWait.outcome === CI_WAIT_OUTCOME.HEAD_CHANGED) {
        const newSha = ciWait.new_head_sha || ciWait.evidence?.new_head_sha;
        if (!newSha || rebind >= maxRebinds) {
          throw new OrchestratorError(
            'PR head changed during CI wait; rebind exhausted',
            'CI_HEAD_CHANGED'
          );
        }
        // Re-bind to the new exact head without launching another worker.
        resolved = {
          branch: candidate.branch,
          commit_sha: assertCommitSha(newSha),
          pr_number: candidate.pr_number,
          pr_url: candidate.pr_url,
        };
        continue;
      }

      if (ciWait.outcome === CI_WAIT_OUTCOME.PR_MISMATCH) {
        throw new OrchestratorError(
          'PR/branch mismatch during exact CI wait',
          'CI_PR_MISMATCH'
        );
      }
    }

    break;
  }

  const verified = await core.verifyCandidate(candidate.candidate_id, {
    githubClient,
    runTaskTests,
    runBuildChecks,
    worker_claim: null,
  });
  return { candidate, verified, ci_wait: ciWait };
}

async function maybeReview(core, {
  task,
  candidate,
  verified,
  invoker,
  getDiff,
}) {
  if (!task.review_required) {
    return core.reviewCandidate(candidate.candidate_id, {
      invoker: null,
      verification: verified.verification,
    });
  }
  if (!invoker) {
    throw new OrchestratorError(
      'review_required=true but Codex invoker unavailable',
      'CODEX_UNAVAILABLE'
    );
  }
  return core.reviewCandidate(candidate.candidate_id, {
    invoker,
    getDiff,
    verification: verified.verification,
  });
}

function decideAfterGates({ task, verified, review, gate }) {
  if (verified.result !== VERIFICATION_RESULT.PASS) {
    if (verified.result === VERIFICATION_RESULT.FAIL) {
      return {
        decision: ORCHESTRATION_DECISION.RETRY,
        failure_class: verified.verification.failure_class || FAILURE_CLASS.TEST_FAIL,
        reason: 'deterministic_verification_failed',
      };
    }
    return {
      decision: ORCHESTRATION_DECISION.BLOCKED,
      failure_class: FAILURE_CLASS.UNKNOWN,
      reason: 'deterministic_verification_blocked',
    };
  }

  if (task.review_required) {
    if (!gate?.ok) {
      if (review?.review_status === REVIEW_STATUS.REQUEST_CHANGES) {
        return {
          decision: ORCHESTRATION_DECISION.RETRY,
          failure_class: FAILURE_CLASS.TEST_FAIL,
          reason: 'codex_request_changes',
        };
      }
      return {
        decision: ORCHESTRATION_DECISION.BLOCKED,
        failure_class: FAILURE_CLASS.UNKNOWN,
        reason: gate?.reason || 'codex_review_blocked',
      };
    }
  }

  return {
    decision: ORCHESTRATION_DECISION.DONE,
    failure_class: null,
    reason: 'verified_and_reviewed',
  };
}

/**
 * Run one owner-submitted software task through the existing Builder pipeline.
 */
export async function runOwnerSoftwareTask(core, ownerTask, options = {}) {
  if (!core?.workerProvider) {
    throw new OrchestratorError(
      'Builder Core has no worker provider configured',
      'NO_PROVIDER'
    );
  }

  const {
    githubClient = null,
    codexInvoker = null,
    getDiff = async () => '',
    runTaskTests = async () => ({ ok: true, output: 'orchestrator default task tests ok' }),
    runBuildChecks = async () => ({ ok: true, output: 'orchestrator default build checks ok' }),
    poll_ms = 2000,
    timeout_ms = 15 * 60 * 1000,
    ci_poll_ms = 5000,
    ci_timeout_ms = 20 * 60 * 1000,
    max_cycles = null,
    owner_prompt = null,
    sleepFn = sleep,
  } = options;

  const trajectory = [];
  const push = (step, detail = {}) => {
    const row = { at: nowIso(), step, ...detail };
    trajectory.push(row);
    return row;
  };

  // 1–5: receive, normalize, lock, mint ids, enforce immutable manifest.
  const task = core.createAndLockTask(ownerTask);
  push('task_locked', {
    task_id: task.task_id,
    proposal_id: task.proposal_id,
    content_hash: task.content_hash,
    review_required: task.review_required,
    allowed_tool_manifest: workerApprovedTools(task).allowed_tool_manifest,
  });
  core.store.appendEvent({
    task_id: task.task_id,
    event_type: EVENT_TYPE.ORCHESTRATION_STARTED,
    payload: {
      task_id: task.task_id,
      intent: task.intent,
      acceptance_ref: task.acceptance_ref,
    },
  });

  const policy = core.getRetryPolicy(task.task_id);
  const cycleCap = max_cycles == null ? policy.max_attempts : Number(max_cycles);
  let attempt = 0;
  let last = {
    task_id: task.task_id,
    factory_run_id: null,
    provider_run_id: null,
    candidate_id: null,
    commit_sha: null,
    verification: null,
    review: null,
  };

  while (attempt < cycleCap) {
    attempt += 1;
    const prompt = buildWorkerPrompt(core.getTask(task.task_id), { owner_prompt });

    // 6–9: launch exactly one worker, persist provider ids, monitor, collect.
    let launched;
    const current = core.getCurrentCodingRun();
    if (current && current.status === RUN_STATUS.PENDING && current.task_id === task.task_id) {
      launched = await core.launchCodingWorkerOnRun({
        factory_run_id: current.factory_run_id,
        prompt,
      });
    } else {
      launched = await core.launchCodingWorker({
        task_id: task.task_id,
        prompt,
      });
    }

    last.factory_run_id = launched.run.factory_run_id;
    last.provider_run_id = launched.run.provider_run_id;
    push('worker_launched', {
      factory_run_id: launched.run.factory_run_id,
      provider_run_id: launched.run.provider_run_id,
      provider_agent_id: launched.run.provider_agent_id,
      attempt,
    });

    if (!launched.run.provider_run_id) {
      return finalize(core, {
        task_id: task.task_id,
        decision: ORCHESTRATION_DECISION.BLOCKED,
        reason: 'provider_run_id_missing',
        trajectory,
        last,
      });
    }

    let terminal;
    try {
      terminal = await waitForWorkerTerminal(core, launched.run.factory_run_id, {
        poll_ms,
        timeout_ms,
      });
    } catch (err) {
      push('worker_wait_failed', { code: err.code, message: err.message });
      const repair = core.beginRepairAttempt(task.task_id, {
        failure_class: FAILURE_CLASS.TIMEOUT,
        reason: err.message,
      });
      if (!repair.allowed) {
        return finalize(core, {
          task_id: task.task_id,
          decision:
            repair.stop_status === TASK_STATUS.NEEDS_OWNER
              ? ORCHESTRATION_DECISION.NEEDS_OWNER
              : ORCHESTRATION_DECISION.BLOCKED,
          reason: repair.reason || 'retry_exhausted',
          trajectory,
          last,
          repair,
        });
      }
      push('retry_started', {
        fresh_factory_run_id: repair.run.factory_run_id,
        reason: 'worker_wait_failed',
      });
      continue;
    }

    if (
      terminal.run.status === RUN_STATUS.FAILED ||
      terminal.run.status === RUN_STATUS.CANCELLED ||
      terminal.run.status === RUN_STATUS.STALE
    ) {
      push('worker_terminal_failure', {
        status: terminal.run.status,
        failure_class: terminal.run.failure_class,
      });
      const repair = core.beginRepairAttempt(task.task_id, {
        failure_class: terminal.run.failure_class || FAILURE_CLASS.WORKER_CRASH,
        reason: `worker_${terminal.run.status}`,
      });
      if (!repair.allowed) {
        return finalize(core, {
          task_id: task.task_id,
          decision:
            repair.stop_status === TASK_STATUS.NEEDS_OWNER
              ? ORCHESTRATION_DECISION.NEEDS_OWNER
              : ORCHESTRATION_DECISION.BLOCKED,
          reason: repair.reason || 'retry_exhausted',
          trajectory,
          last,
          repair,
        });
      }
      push('retry_started', {
        fresh_factory_run_id: repair.run.factory_run_id,
        reason: 'worker_terminal_failure',
      });
      continue;
    }

    const { collected, landing } = await collectLanding(
      core,
      launched.run.factory_run_id
    );
    push('worker_collected', {
      factory_run_id: collected.run.factory_run_id,
      landing,
    });

    // Stale/cancelled cannot complete task.
    const runNow = core.getRun(launched.run.factory_run_id);
    if (
      runNow.status === RUN_STATUS.STALE ||
      runNow.status === RUN_STATUS.CANCELLED
    ) {
      return finalize(core, {
        task_id: task.task_id,
        decision: ORCHESTRATION_DECISION.BLOCKED,
        reason: 'stale_or_cancelled_run',
        trajectory,
        last,
      });
    }

    let candidate;
    let verified;
    let ci_wait = null;
    try {
      ({ candidate, verified, ci_wait } = await registerAndVerify(core, {
        task: core.getTask(task.task_id),
        run: runNow,
        landing,
        githubClient,
        runTaskTests,
        runBuildChecks,
        ci_poll_ms,
        ci_timeout_ms,
        sleepFn,
        onCiWait: (w) =>
          push('ci_wait', {
            outcome: w.outcome,
            ci_status: w.evidence?.ci_status,
            ci_conclusion: w.evidence?.ci_conclusion,
            polls: w.evidence?.polls,
          }),
      }));
    } catch (err) {
      push('candidate_or_verify_failed', {
        code: err.code,
        message: err.message,
      });
      const repair = core.beginRepairAttempt(task.task_id, {
        failure_class: FAILURE_CLASS.CI_FAIL,
        reason: err.message,
      });
      if (!repair.allowed) {
        return finalize(core, {
          task_id: task.task_id,
          decision:
            repair.stop_status === TASK_STATUS.NEEDS_OWNER
              ? ORCHESTRATION_DECISION.NEEDS_OWNER
              : ORCHESTRATION_DECISION.BLOCKED,
          reason: repair.reason || err.code || 'candidate_verify_failed',
          trajectory,
          last,
          repair,
        });
      }
      push('retry_started', {
        fresh_factory_run_id: repair.run.factory_run_id,
        reason: 'candidate_or_verify_failed',
      });
      continue;
    }

    last.candidate_id = candidate.candidate_id;
    last.commit_sha = candidate.commit_sha;
    last.ci_wait = ci_wait
      ? {
          outcome: ci_wait.outcome,
          ci_status: ci_wait.evidence?.ci_status,
          ci_conclusion: ci_wait.evidence?.ci_conclusion,
        }
      : null;
    last.verification = {
      verification_id: verified.verification.verification_id,
      result: verified.result,
    };
    push('verified', last.verification);

    // Codex runs only after deterministic PASS (existing Stage-1 gate order).
    let review = null;
    let gate = null;
    if (verified.result === VERIFICATION_RESULT.PASS) {
      try {
        ({ review, gate } = await maybeReview(core, {
          task: core.getTask(task.task_id),
          candidate: core.store.getCandidate(candidate.candidate_id),
          verified,
          invoker: codexInvoker,
          getDiff,
        }));
      } catch (err) {
        push('review_failed', { code: err.code, message: err.message });
        return finalize(core, {
          task_id: task.task_id,
          decision: ORCHESTRATION_DECISION.BLOCKED,
          reason: err.code || 'review_failed',
          trajectory,
          last,
          verification: verified,
        });
      }

      last.review = review
        ? {
            review_id: review.review_id,
            review_status: review.review_status,
            verification_id: review.evidence?.verification_id || null,
          }
        : null;
      push('reviewed', { ...last.review, gate: gate?.status });
    }

    const decision = decideAfterGates({
      task: core.getTask(task.task_id),
      verified,
      review,
      gate,
    });
    push('decision', decision);

    if (decision.decision === ORCHESTRATION_DECISION.DONE) {
      core.updateTaskStatus(task.task_id, TASK_STATUS.ACCEPTED);
      return finalize(core, {
        task_id: task.task_id,
        decision: ORCHESTRATION_DECISION.DONE,
        reason: decision.reason,
        trajectory,
        last,
        verification: verified,
        review,
        gate,
      });
    }

    if (decision.decision === ORCHESTRATION_DECISION.BLOCKED) {
      if (core.getTask(task.task_id).status !== TASK_STATUS.BLOCKED) {
        core.updateTaskStatus(task.task_id, TASK_STATUS.BLOCKED);
      }
      return finalize(core, {
        task_id: task.task_id,
        decision: ORCHESTRATION_DECISION.BLOCKED,
        reason: decision.reason,
        trajectory,
        last,
        verification: verified,
        review,
        gate,
      });
    }

    // RETRY via existing bounded repair policy (fresh factory_run_id).
    const repair = core.beginRepairAttempt(task.task_id, {
      failure_class: decision.failure_class || FAILURE_CLASS.TEST_FAIL,
      reason: decision.reason,
    });
    if (!repair.allowed) {
      return finalize(core, {
        task_id: task.task_id,
        decision:
          repair.stop_status === TASK_STATUS.NEEDS_OWNER
            ? ORCHESTRATION_DECISION.NEEDS_OWNER
            : ORCHESTRATION_DECISION.BLOCKED,
        reason: repair.reason || 'retry_exhausted',
        trajectory,
        last,
        verification: verified,
        review,
        gate,
        repair,
      });
    }
    push('retry_started', {
      fresh_factory_run_id: repair.run.factory_run_id,
      reason: decision.reason,
      previous_evidence_preserved: true,
    });
  }

  core.updateTaskStatus(task.task_id, TASK_STATUS.NEEDS_OWNER);
  return finalize(core, {
    task_id: task.task_id,
    decision: ORCHESTRATION_DECISION.NEEDS_OWNER,
    reason: 'cycle_cap_exhausted',
    trajectory,
    last,
  });
}

/**
 * Resume CI wait + deterministic verification after process restart.
 * Does not launch a coding worker. Requires an existing exact candidate.
 */
export async function resumeExactCandidateCiAndVerify(
  core,
  {
    task_id,
    githubClient,
    runTaskTests = async () => ({
      ok: true,
      output: 'orchestrator default task tests ok',
    }),
    runBuildChecks = async () => ({
      ok: true,
      output: 'orchestrator default build checks ok',
    }),
    ci_poll_ms = 5000,
    ci_timeout_ms = 20 * 60 * 1000,
    sleepFn = sleep,
  } = {}
) {
  const awaiting = detectAwaitingCi(core, task_id);
  if (!awaiting.awaiting_ci || !awaiting.candidate) {
    throw new OrchestratorError(
      'task is not awaiting exact CI for an existing candidate',
      'NOT_AWAITING_CI'
    );
  }
  const candidate = awaiting.candidate;
  const ci_wait = await waitForExactCandidateCi(core, {
    candidate_id: candidate.candidate_id,
    githubClient,
    poll_ms: ci_poll_ms,
    timeout_ms: ci_timeout_ms,
    sleepFn,
  });
  if (ci_wait.outcome === CI_WAIT_OUTCOME.HEAD_CHANGED) {
    throw new OrchestratorError(
      'PR head changed during resumed CI wait; re-bind required',
      'CI_HEAD_CHANGED'
    );
  }
  if (ci_wait.outcome === CI_WAIT_OUTCOME.PR_MISMATCH) {
    throw new OrchestratorError(
      'PR/branch mismatch during resumed CI wait',
      'CI_PR_MISMATCH'
    );
  }
  const verified = await core.verifyCandidate(candidate.candidate_id, {
    githubClient,
    runTaskTests,
    runBuildChecks,
    worker_claim: null,
  });
  return {
    candidate: core.store.getCandidate(candidate.candidate_id),
    verified,
    ci_wait,
    duplicate_worker_launch: false,
  };
}

function finalize(core, {
  task_id,
  decision,
  reason,
  trajectory,
  last,
  verification = null,
  review = null,
  gate = null,
  repair = null,
}) {
  const task = core.getTask(task_id);
  const result = {
    ok: decision === ORCHESTRATION_DECISION.DONE,
    decision,
    reason,
    task_id,
    task_status: task.status,
    factory_run_id: last.factory_run_id,
    provider_run_id: last.provider_run_id,
    candidate_id: last.candidate_id,
    commit_sha: last.commit_sha,
    verification: last.verification ||
      (verification
        ? {
            verification_id: verification.verification.verification_id,
            result: verification.result,
          }
        : null),
    review: last.review ||
      (review
        ? {
            review_id: review.review_id,
            review_status: review.review_status,
            verification_id: review.evidence?.verification_id || null,
          }
        : null),
    gate: gate || null,
    repair: repair
      ? {
          allowed: repair.allowed,
          stop_status: repair.stop_status || null,
          reason: repair.reason || null,
          fresh_factory_run_id: repair.run?.factory_run_id || null,
        }
      : null,
    trajectory,
    owner_interventions: 0,
    completed_at: nowIso(),
  };

  core.store.appendEvent({
    task_id,
    factory_run_id: last.factory_run_id,
    event_type: EVENT_TYPE.ORCHESTRATION_DECIDED,
    payload: {
      decision,
      reason,
      task_status: task.status,
      candidate_id: last.candidate_id,
      commit_sha: last.commit_sha,
      verification: result.verification,
      review: result.review,
    },
  });
  return result;
}

export function createDefaultOrchestrationDeps({
  repoRoot = process.cwd(),
  enableGithub = true,
  enableCodex = true,
} = {}) {
  let githubClient = null;
  let codexInvoker = null;
  if (enableGithub) {
    try {
      githubClient = createGhLandingClient({ cwd: repoRoot });
    } catch {
      githubClient = null;
    }
  }
  if (enableCodex) {
    try {
      codexInvoker = createCodexReviewInvoker({
        repoRoot,
        timeoutMs: 10 * 60 * 1000,
      });
    } catch {
      codexInvoker = null;
    }
  }
  return { githubClient, codexInvoker };
}
