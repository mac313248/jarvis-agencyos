// Exact GitHub candidate registry for Builder Stage 1.
// GitHub landing truth binds branch/SHA/PR/CI. Worker prose is not evidence.

import {
  APPROVAL_STATUS,
  CANDIDATE_STATUS,
  EVENT_TYPE,
  assertCommitSha,
  newCandidateId,
} from './contracts.js';
import { BuilderCoreError } from './errors.js';
import { TaskLockError, verifyTaskHash } from './task-lock.js';
import { invalidateVerification } from './verifier.js';
import { invalidateReview } from './codex-review.js';

function nowIso() {
  return new Date().toISOString();
}

export function assertRunCanRegisterCandidate(run, { current = null } = {}) {
  if (!run) {
    throw new BuilderCoreError('unknown factory_run_id', 'UNKNOWN_RUN');
  }
  if (run.status === 'STALE' || run.status === 'CANCELLED') {
    throw new BuilderCoreError(
      `cancelled/stale run cannot become authoritative: ${run.factory_run_id}`,
      'STALE_RUN'
    );
  }
  if (current && current.factory_run_id !== run.factory_run_id) {
    throw new BuilderCoreError(
      `stale run rejected: ${run.factory_run_id}`,
      'STALE_RUN'
    );
  }
  if (!run.provider_run_id) {
    throw new BuilderCoreError(
      'candidate requires provider_run_id binding on the run',
      'MISSING_PROVIDER_MAPPING'
    );
  }
  return run;
}

/**
 * Register an exact software candidate identity.
 * Required: task_id, factory_run_id, branch, commit_sha.
 * PR/CI fields captured when present. Worker claims are ignored.
 */
export function registerExactCandidate(core, input) {
  const {
    task_id,
    factory_run_id,
    branch,
    commit_sha,
    pr_number = null,
    pr_url = null,
    pr_ref = null,
    ci_status = null,
    ci_conclusion = null,
    ci_ref = null,
    evidence_at = null,
    worker_claim = null,
  } = input || {};

  if (worker_claim != null) {
    // Explicitly non-authoritative: may be logged, never trusted for merge/CI.
  }

  const task = core.store.getTask(task_id);
  if (!task) throw new TaskLockError(`unknown task_id: ${task_id}`);
  verifyTaskHash(task);

  const run = core.store.getRun(factory_run_id);
  if (!run || run.task_id !== task_id) {
    throw new TaskLockError('factory_run_id does not belong to task');
  }

  try {
    assertRunCanRegisterCandidate(run, { current: core.getCurrentCodingRun() });
  } catch (err) {
    core.store.appendEvent({
      task_id,
      factory_run_id,
      event_type: EVENT_TYPE.STALE_RUN_REJECTED,
      payload: {
        reason: 'candidate_from_cancelled_or_stale_run',
        status: run.status,
        code: err.code,
      },
    });
    throw err;
  }

  if (typeof branch !== 'string' || !branch.trim()) {
    throw new BuilderCoreError('candidate requires branch', 'MISSING_BRANCH');
  }
  const sha = assertCommitSha(commit_sha);

  // Supersede prior candidates for this task with a different SHA and
  // invalidate their verifications/approvals (SHA A never authorizes SHA B).
  const prior = core.store.listCandidatesForTask(task_id);
  for (const old of prior) {
    if (!old.commit_sha || old.commit_sha === sha) continue;
    if (old.status === CANDIDATE_STATUS.SUPERSEDED) continue;
    core.store.updateCandidate(old.candidate_id, {
      status: CANDIDATE_STATUS.SUPERSEDED,
    });
    if (old.verification_ref) {
      try {
        invalidateVerification(
          core,
          old.verification_ref,
          `commit changed ${old.commit_sha} -> ${sha}`
        );
      } catch {}
    }
    if (old.review_ref) {
      try {
        invalidateReview(
          core,
          old.review_ref,
          `commit changed ${old.commit_sha} -> ${sha}`
        );
      } catch {}
    }
    const approvals = core.store.listApprovalsForTask(task_id);
    for (const ap of approvals) {
      if (ap.candidate_id === old.candidate_id && ap.status === APPROVAL_STATUS.APPROVED) {
        core.store.updateApproval(ap.approval_id, {
          status: APPROVAL_STATUS.INVALIDATED,
        });
        core.store.appendEvent({
          task_id,
          factory_run_id,
          event_type: EVENT_TYPE.APPROVAL_INVALIDATED,
          payload: {
            approval_id: ap.approval_id,
            reason: 'candidate_commit_sha_changed',
            old_commit_sha: old.commit_sha,
            new_commit_sha: sha,
          },
        });
      }
    }
  }

  const evidenceTimestamp = evidence_at || nowIso();
  const normalizedPrRef =
    pr_ref ||
    (pr_number != null ? String(pr_number) : null) ||
    pr_url ||
    null;

  const candidate = core.store.insertCandidate({
    candidate_id: newCandidateId(),
    task_id,
    factory_run_id,
    provider_run_id: run.provider_run_id,
    branch: branch.trim(),
    commit_sha: sha,
    pr_number: pr_number == null ? null : Number(pr_number),
    pr_url: pr_url || null,
    pr_ref: normalizedPrRef,
    ci_status,
    ci_conclusion,
    ci_ref:
      ci_ref ||
      (ci_status
        ? JSON.stringify({ ci_status, ci_conclusion, commit_sha: sha })
        : null),
    verification_ref: null,
    review_ref: null,
    evidence_at: evidenceTimestamp,
    status: CANDIDATE_STATUS.PROPOSED,
  });

  core.store.appendEvent({
    task_id,
    factory_run_id,
    event_type: EVENT_TYPE.CANDIDATE_RECORDED,
    evidence_ref: evidenceTimestamp,
    payload: {
      candidate_id: candidate.candidate_id,
      provider_run_id: candidate.provider_run_id,
      branch: candidate.branch,
      commit_sha: candidate.commit_sha,
      pr_number: candidate.pr_number,
      pr_url: candidate.pr_url,
      ci_status: candidate.ci_status,
      ci_conclusion: candidate.ci_conclusion,
      evidence_at: candidate.evidence_at,
      worker_claim_ignored: worker_claim != null,
    },
  });

  return candidate;
}

/**
 * Refresh PR/CI landing fields for an existing candidate's exact SHA.
 * Never copies CI from another SHA.
 */
export async function refreshCandidateLanding(core, candidateId, githubClient) {
  const candidate = core.store.getCandidate(candidateId);
  if (!candidate) {
    throw new BuilderCoreError(`unknown candidate_id: ${candidateId}`, 'UNKNOWN_CANDIDATE');
  }
  const sha = assertCommitSha(candidate.commit_sha);
  const commit = await githubClient.getCommit(sha);
  if (commit.sha !== sha && !commit.sha.startsWith(sha) && sha !== commit.sha) {
    // GitHub returns full SHA; require exact match.
  }
  if (commit.sha !== sha) {
    throw new BuilderCoreError(
      `github commit sha mismatch: expected ${sha} got ${commit.sha}`,
      'SHA_MISMATCH'
    );
  }

  let pr_number = candidate.pr_number;
  let pr_url = candidate.pr_url;
  if (pr_number) {
    const pr = await githubClient.getPullRequest(pr_number);
    if (pr.head_sha !== sha) {
      throw new BuilderCoreError(
        `PR #${pr_number} head ${pr.head_sha} does not match candidate sha ${sha}`,
        'PR_SHA_MISMATCH'
      );
    }
    pr_url = pr.html_url;
  } else if (candidate.branch) {
    const found = await githubClient.findPullRequestsForHead(candidate.branch);
    if (found[0]) {
      pr_number = found[0].number;
      pr_url = found[0].html_url;
      const pr = await githubClient.getPullRequest(pr_number);
      if (pr.head_sha !== sha) {
        // Branch moved; do not bind mismatched PR head.
        pr_number = candidate.pr_number;
        pr_url = candidate.pr_url;
      }
    }
  }

  const checkRuns = await githubClient.getCheckRunsForCommit(sha);
  const combined = await githubClient.getCombinedStatusForCommit(sha);
  const summary = githubClient.summarizeCi({ checkRuns, combinedStatus: combined });

  return core.store.updateCandidate(candidateId, {
    pr_number,
    pr_url,
    pr_ref: pr_number != null ? String(pr_number) : candidate.pr_ref,
    ci_status: summary.ci_status,
    ci_conclusion: summary.ci_conclusion,
    ci_ref: JSON.stringify({
      commit_sha: sha,
      ci_status: summary.ci_status,
      ci_conclusion: summary.ci_conclusion,
      checks: summary.checks,
      combined_state: summary.combined_state,
    }),
    evidence_at: summary.captured_at,
  });
}
