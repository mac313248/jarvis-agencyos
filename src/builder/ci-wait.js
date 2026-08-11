// Bounded exact-SHA GitHub CI wait for Builder Stage 1.
// Never treats pending as PASS. Never bypasses CI for smoke.
// CI evidence for SHA A cannot authorize SHA B.

import {
  CANDIDATE_STATUS,
  EVENT_TYPE,
  RUN_STATUS,
  VERIFICATION_RESULT,
  assertCommitSha,
} from './contracts.js';
import { BuilderCoreError } from './errors.js';
import { invalidateVerification } from './verifier.js';
import { invalidateReview } from './codex-review.js';

export const CI_WAIT_OUTCOME = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
  HEAD_CHANGED: 'HEAD_CHANGED',
  PR_MISMATCH: 'PR_MISMATCH',
});

function nowIso() {
  return new Date().toISOString();
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Classify a CI summary into a wait terminal or continue signal.
 * GitHub timed_out/cancelled/failure are terminal FAILURE.
 * Our own wait budget expiry is TIMEOUT (caller).
 */
export function classifyCiSummary(summary) {
  const status = String(summary?.ci_status || '');
  const conclusion = summary?.ci_conclusion;
  if (status === 'pending') {
    return { terminal: false, outcome: null };
  }
  if (status === 'completed' && conclusion === 'success') {
    return { terminal: true, outcome: CI_WAIT_OUTCOME.SUCCESS };
  }
  if (
    status === 'completed' &&
    (conclusion === 'failure' ||
      conclusion === 'cancelled' ||
      conclusion === 'timed_out')
  ) {
    return { terminal: true, outcome: CI_WAIT_OUTCOME.FAILURE };
  }
  if (status === 'completed' && conclusion === 'neutral') {
    // Neutral/skipped-only suites are not success; fail closed as UNKNOWN.
    return { terminal: true, outcome: CI_WAIT_OUTCOME.UNKNOWN };
  }
  if (status === 'unknown' || !status) {
    return { terminal: false, outcome: null };
  }
  return { terminal: false, outcome: null };
}

function buildCiEvidence({
  candidate,
  sha,
  pr,
  summary,
  checkRuns,
  started_at,
  finished_at = null,
  polls = 0,
  outcome = null,
}) {
  return {
    candidate_id: candidate.candidate_id,
    commit_sha: sha,
    branch: candidate.branch,
    pr_number: pr?.number ?? candidate.pr_number,
    pr_url: pr?.html_url ?? candidate.pr_url,
    pr_head_ref: pr?.head_ref ?? null,
    pr_head_sha: pr?.head_sha ?? null,
    ci_status: summary?.ci_status ?? null,
    ci_conclusion: summary?.ci_conclusion ?? null,
    combined_state: summary?.combined_state ?? null,
    check_run_ids: (checkRuns || [])
      .map((r) => r.id)
      .filter((id) => id != null),
    checks: (checkRuns || []).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      html_url: r.html_url ?? null,
    })),
    started_at,
    finished_at,
    polls,
    outcome,
    captured_at: summary?.captured_at || nowIso(),
  };
}

/**
 * Snapshot whether a task is mid CI-wait (safe to resume without worker launch).
 */
export function detectAwaitingCi(core, taskId) {
  const candidates = core.store.listCandidatesForTask(taskId);
  const live = candidates
    .filter((c) => c.status !== CANDIDATE_STATUS.SUPERSEDED)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const candidate = live[0] || null;
  if (!candidate) {
    return { awaiting_ci: false, candidate: null, run: null };
  }
  const run = core.store.getRun(candidate.factory_run_id);
  if (!run || run.status !== RUN_STATUS.SUCCEEDED) {
    return { awaiting_ci: false, candidate, run };
  }
  const verification = candidate.verification_ref
    ? core.store.getVerification(candidate.verification_ref)
    : null;
  if (
    verification &&
    verification.result === VERIFICATION_RESULT.PASS &&
    !verification.invalidated_at
  ) {
    return { awaiting_ci: false, candidate, run, verification };
  }
  const pendingCi =
    !candidate.ci_status ||
    candidate.ci_status === 'pending' ||
    candidate.ci_status === 'unknown' ||
    (verification && verification.result === VERIFICATION_RESULT.BLOCKED);
  return {
    awaiting_ci: Boolean(pendingCi),
    candidate,
    run,
    verification,
  };
}

/**
 * Poll GitHub until CI for the exact candidate SHA is terminal, or bound expires.
 */
export async function waitForExactCandidateCi(
  core,
  {
    candidate_id,
    githubClient,
    poll_ms = 5000,
    timeout_ms = 20 * 60 * 1000,
    sleepFn = defaultSleep,
    nowFn = () => Date.now(),
  } = {}
) {
  if (!githubClient) {
    throw new BuilderCoreError(
      'githubClient required for exact CI wait',
      'GITHUB_REQUIRED'
    );
  }
  if (!Number.isFinite(poll_ms) || poll_ms < 1) {
    throw new BuilderCoreError('ci poll_ms must be >= 1', 'INVALID_CI_POLL');
  }
  if (!Number.isFinite(timeout_ms) || timeout_ms < 1) {
    throw new BuilderCoreError('ci timeout_ms must be >= 1', 'INVALID_CI_TIMEOUT');
  }

  let candidate = core.store.getCandidate(candidate_id);
  if (!candidate) {
    throw new BuilderCoreError(
      `unknown candidate_id: ${candidate_id}`,
      'UNKNOWN_CANDIDATE'
    );
  }
  const boundSha = assertCommitSha(candidate.commit_sha);
  if (!candidate.branch) {
    throw new BuilderCoreError(
      'candidate missing branch for CI wait',
      'MISSING_BRANCH'
    );
  }
  if (candidate.pr_number == null) {
    throw new BuilderCoreError(
      'candidate missing pr_number for CI wait',
      'MISSING_PR'
    );
  }

  const started_at = nowIso();
  const deadline = nowFn() + timeout_ms;
  let polls = 0;
  let lastEvidence = null;

  core.store.appendEvent({
    task_id: candidate.task_id,
    factory_run_id: candidate.factory_run_id,
    event_type: EVENT_TYPE.CI_WAIT_STARTED,
    payload: {
      candidate_id,
      commit_sha: boundSha,
      branch: candidate.branch,
      pr_number: candidate.pr_number,
      poll_ms,
      timeout_ms,
      started_at,
    },
  });

  while (nowFn() < deadline) {
    polls += 1;
    candidate = core.store.getCandidate(candidate_id);
    const sha = assertCommitSha(candidate.commit_sha);
    if (sha !== boundSha) {
      // Bound SHA changed under us — fail closed for this wait.
      const evidence = buildCiEvidence({
        candidate,
        sha,
        pr: null,
        summary: null,
        checkRuns: [],
        started_at,
        finished_at: nowIso(),
        polls,
        outcome: CI_WAIT_OUTCOME.HEAD_CHANGED,
      });
      core.store.appendEvent({
        task_id: candidate.task_id,
        factory_run_id: candidate.factory_run_id,
        event_type: EVENT_TYPE.CI_WAIT_INVALIDATED,
        payload: evidence,
      });
      return {
        outcome: CI_WAIT_OUTCOME.HEAD_CHANGED,
        evidence,
        candidate,
      };
    }

    const commit = await githubClient.getCommit(sha);
    if (!commit?.sha || commit.sha !== sha) {
      throw new BuilderCoreError(
        `github commit sha mismatch during CI wait: expected ${sha} got ${commit?.sha}`,
        'SHA_MISMATCH'
      );
    }

    const pr = await githubClient.getPullRequest(candidate.pr_number);
    if (pr.head_ref !== candidate.branch) {
      const evidence = buildCiEvidence({
        candidate,
        sha,
        pr,
        summary: null,
        checkRuns: [],
        started_at,
        finished_at: nowIso(),
        polls,
        outcome: CI_WAIT_OUTCOME.PR_MISMATCH,
      });
      if (candidate.verification_ref) {
        invalidateVerification(core, candidate.verification_ref, 'ci_pr_branch_mismatch');
      }
      if (candidate.review_ref) {
        invalidateReview(core, candidate.review_ref, 'ci_pr_branch_mismatch');
      }
      core.store.appendEvent({
        task_id: candidate.task_id,
        factory_run_id: candidate.factory_run_id,
        event_type: EVENT_TYPE.CI_WAIT_FINISHED,
        payload: evidence,
      });
      return {
        outcome: CI_WAIT_OUTCOME.PR_MISMATCH,
        evidence,
        candidate,
      };
    }
    if (pr.head_sha !== sha) {
      if (candidate.verification_ref) {
        invalidateVerification(core, candidate.verification_ref, 'ci_pr_head_changed');
      }
      if (candidate.review_ref) {
        invalidateReview(core, candidate.review_ref, 'ci_pr_head_changed');
      }
      const evidence = buildCiEvidence({
        candidate,
        sha,
        pr,
        summary: null,
        checkRuns: [],
        started_at,
        finished_at: nowIso(),
        polls,
        outcome: CI_WAIT_OUTCOME.HEAD_CHANGED,
      });
      core.store.appendEvent({
        task_id: candidate.task_id,
        factory_run_id: candidate.factory_run_id,
        event_type: EVENT_TYPE.CI_WAIT_INVALIDATED,
        payload: {
          ...evidence,
          new_head_sha: pr.head_sha,
          bound_sha: sha,
        },
      });
      return {
        outcome: CI_WAIT_OUTCOME.HEAD_CHANGED,
        evidence: { ...evidence, new_head_sha: pr.head_sha },
        candidate,
        new_head_sha: pr.head_sha,
      };
    }

    // Exact-SHA CI only — never query another SHA's checks.
    const checkRuns = await githubClient.getCheckRunsForCommit(sha);
    const combined = await githubClient.getCombinedStatusForCommit(sha);
    const summary = githubClient.summarizeCi({
      checkRuns,
      combinedStatus: combined,
    });

    // Reject accidental cross-SHA contamination if client returns tagged runs.
    for (const run of checkRuns || []) {
      if (run.head_sha && run.head_sha !== sha) {
        throw new BuilderCoreError(
          `CI check run head_sha ${run.head_sha} does not match candidate ${sha}`,
          'CI_SHA_MISMATCH'
        );
      }
    }

    lastEvidence = buildCiEvidence({
      candidate,
      sha,
      pr,
      summary,
      checkRuns,
      started_at,
      polls,
      outcome: null,
    });

    core.store.updateCandidate(candidate_id, {
      pr_number: pr.number,
      pr_url: pr.html_url,
      pr_ref: String(pr.number),
      ci_status: summary.ci_status,
      ci_conclusion: summary.ci_conclusion,
      ci_ref: JSON.stringify(lastEvidence),
      evidence_at: summary.captured_at,
    });

    core.store.appendEvent({
      task_id: candidate.task_id,
      factory_run_id: candidate.factory_run_id,
      event_type: EVENT_TYPE.CI_WAIT_PROGRESS,
      payload: {
        candidate_id,
        commit_sha: sha,
        pr_number: pr.number,
        ci_status: summary.ci_status,
        ci_conclusion: summary.ci_conclusion,
        polls,
        check_run_ids: lastEvidence.check_run_ids,
        captured_at: summary.captured_at,
      },
    });

    const classified = classifyCiSummary(summary);
    if (classified.terminal) {
      const finished_at = nowIso();
      const evidence = {
        ...lastEvidence,
        finished_at,
        outcome: classified.outcome,
      };
      core.store.updateCandidate(candidate_id, {
        ci_ref: JSON.stringify(evidence),
        evidence_at: finished_at,
      });
      core.store.appendEvent({
        task_id: candidate.task_id,
        factory_run_id: candidate.factory_run_id,
        event_type: EVENT_TYPE.CI_WAIT_FINISHED,
        payload: evidence,
      });
      return {
        outcome: classified.outcome,
        evidence,
        candidate: core.store.getCandidate(candidate_id),
      };
    }

    const remaining = deadline - nowFn();
    if (remaining <= 0) break;
    await sleepFn(Math.min(poll_ms, remaining));
  }

  const finished_at = nowIso();
  const evidence = {
    ...(lastEvidence ||
      buildCiEvidence({
        candidate,
        sha: boundSha,
        pr: null,
        summary: { ci_status: 'pending', ci_conclusion: null },
        checkRuns: [],
        started_at,
        polls,
      })),
    finished_at,
    outcome: CI_WAIT_OUTCOME.TIMEOUT,
  };
  core.store.updateCandidate(candidate_id, {
    ci_ref: JSON.stringify(evidence),
    evidence_at: finished_at,
  });
  core.store.appendEvent({
    task_id: candidate.task_id,
    factory_run_id: candidate.factory_run_id,
    event_type: EVENT_TYPE.CI_WAIT_FINISHED,
    payload: evidence,
  });
  return {
    outcome: CI_WAIT_OUTCOME.TIMEOUT,
    evidence,
    candidate: core.store.getCandidate(candidate_id),
  };
}
