// Deterministic Stage-1 verifier.
// Verifies the EXACT candidate commit_sha. Worker self-certification is void.

import {
  CANDIDATE_STATUS,
  EVENT_TYPE,
  FAILURE_CLASS,
  TASK_STATUS,
  VERIFICATION_RESULT,
  assertCommitSha,
  newId,
} from './contracts.js';

export { VERIFICATION_RESULT };

export class VerifierError extends Error {
  constructor(message, code = 'VERIFIER_ERROR') {
    super(message);
    this.name = 'VerifierError';
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function assertExactShaBinding(candidate, commitSha) {
  const expected = assertCommitSha(candidate.commit_sha);
  const presented = assertCommitSha(commitSha);
  if (expected !== presented) {
    throw new VerifierError(
      `verification for SHA ${presented} cannot authorize candidate SHA ${expected}`,
      'SHA_MISMATCH'
    );
  }
  return expected;
}

/**
 * Deterministic verification profile for one exact candidate SHA.
 * @param {object} args
 * @param {import('./core.js').BuilderCore} args.core
 * @param {string} args.candidate_id
 * @param {object} [args.githubClient] landing-truth client
 * @param {Function} [args.runTaskTests] async ({commit_sha, candidate, task}) => {ok, output, name?}
 * @param {Function} [args.runBuildChecks] async (...) => {ok, output, name?}
 * @param {string|null} [args.worker_claim] ignored for authority; recorded only
 */
export async function verifyExactCandidate({
  core,
  candidate_id,
  githubClient = null,
  runTaskTests = null,
  runBuildChecks = null,
  worker_claim = null,
}) {
  const candidate = core.store.getCandidate(candidate_id);
  if (!candidate) {
    throw new VerifierError(`unknown candidate_id: ${candidate_id}`, 'UNKNOWN_CANDIDATE');
  }
  if (!candidate.commit_sha) {
    throw new VerifierError('candidate missing exact commit_sha', 'MISSING_SHA');
  }
  if (
    candidate.status === CANDIDATE_STATUS.SUPERSEDED ||
    candidate.status === CANDIDATE_STATUS.REJECTED
  ) {
    throw new VerifierError(
      `candidate not eligible for verification: ${candidate.status}`,
      'CANDIDATE_INELIGIBLE'
    );
  }

  const run = core.store.getRun(candidate.factory_run_id);
  if (!run) {
    throw new VerifierError('candidate factory_run_id missing', 'MISSING_RUN');
  }
  if (run.status === 'STALE' || run.status === 'CANCELLED') {
    core.store.appendEvent({
      task_id: candidate.task_id,
      factory_run_id: candidate.factory_run_id,
      event_type: EVENT_TYPE.STALE_RUN_REJECTED,
      payload: {
        reason: 'verify_from_cancelled_or_stale_run',
        status: run.status,
        candidate_id,
      },
    });
    throw new VerifierError(
      `cancelled/stale run cannot authorize candidate: ${candidate.factory_run_id}`,
      'STALE_RUN'
    );
  }

  const sha = assertCommitSha(candidate.commit_sha);
  const task = core.getTask(candidate.task_id);
  const checks = [];

  // Worker prose is never acceptance evidence.
  if (worker_claim != null) {
    checks.push({
      name: 'worker_self_certification',
      ok: null,
      authoritative: false,
      detail: String(worker_claim).slice(0, 200),
    });
  }

  if (typeof runTaskTests === 'function') {
    const t = await runTaskTests({ commit_sha: sha, candidate, task });
    checks.push({
      name: t?.name || 'task_tests',
      ok: Boolean(t?.ok),
      authoritative: true,
      detail: String(t?.output || '').slice(0, 2000),
    });
  }

  if (typeof runBuildChecks === 'function') {
    const b = await runBuildChecks({ commit_sha: sha, candidate, task });
    checks.push({
      name: b?.name || 'build_typecheck_lint',
      ok: Boolean(b?.ok),
      authoritative: true,
      detail: String(b?.output || '').slice(0, 2000),
    });
  }

  let ciSummary = null;
  if (githubClient) {
    try {
      const checkRuns = await githubClient.getCheckRunsForCommit(sha);
      const combined = await githubClient.getCombinedStatusForCommit(sha);
      ciSummary = githubClient.summarizeCi({
        checkRuns,
        combinedStatus: combined,
      });
      // Refresh candidate CI landing fields for the exact SHA only.
      core.store.updateCandidate(candidate_id, {
        ci_status: ciSummary.ci_status,
        ci_conclusion: ciSummary.ci_conclusion,
        ci_ref: JSON.stringify({
          commit_sha: sha,
          ci_status: ciSummary.ci_status,
          ci_conclusion: ciSummary.ci_conclusion,
          checks: ciSummary.checks,
          combined_state: ciSummary.combined_state,
        }),
        evidence_at: ciSummary.captured_at,
      });
      checks.push({
        name: 'github_ci',
        ok:
          ciSummary.ci_conclusion == null
            ? null
            : ciSummary.ci_conclusion === 'success',
        authoritative: true,
        detail: JSON.stringify({
          ci_status: ciSummary.ci_status,
          ci_conclusion: ciSummary.ci_conclusion,
          combined_state: ciSummary.combined_state,
        }),
      });
    } catch (err) {
      checks.push({
        name: 'github_ci',
        ok: null,
        authoritative: true,
        detail: `ci_fetch_failed: ${err.message}`,
      });
    }
  }

  const authoritative = checks.filter((c) => c.authoritative);
  const hardFails = authoritative.filter((c) => c.ok === false);
  const unknowns = authoritative.filter((c) => c.ok == null);
  const hardPasses = authoritative.filter((c) => c.ok === true);

  // Worker claim PASS can never override a failing authoritative check.
  const workerSaidPass =
    typeof worker_claim === 'string' &&
    /\bPASS\b/i.test(worker_claim) &&
    !/\bFAIL\b/i.test(worker_claim);

  let result = VERIFICATION_RESULT.PASS;
  let failure_class = null;
  if (hardFails.length) {
    result = VERIFICATION_RESULT.FAIL;
    failure_class = hardFails.some((c) => c.name === 'github_ci')
      ? FAILURE_CLASS.CI_FAIL
      : FAILURE_CLASS.TEST_FAIL;
  } else if (!hardPasses.length && unknowns.length) {
    result = VERIFICATION_RESULT.BLOCKED;
  } else if (workerSaidPass && hardFails.length) {
    result = VERIFICATION_RESULT.FAIL;
    failure_class = FAILURE_CLASS.TEST_FAIL;
  }

  // If only worker claim exists and nothing authoritative ran → BLOCKED.
  if (!authoritative.length) {
    result = VERIFICATION_RESULT.BLOCKED;
  }

  const verification = core.store.insertVerification({
    verification_id: newId('ver'),
    candidate_id,
    commit_sha: sha,
    result,
    checks,
    worker_claim: worker_claim == null ? null : String(worker_claim),
    failure_class,
    created_at: nowIso(),
  });

  const nextCandidateStatus =
    result === VERIFICATION_RESULT.PASS
      ? CANDIDATE_STATUS.VERIFIED
      : result === VERIFICATION_RESULT.FAIL
        ? CANDIDATE_STATUS.REJECTED
        : CANDIDATE_STATUS.VERIFYING;

  core.store.updateCandidate(candidate_id, {
    status: nextCandidateStatus,
    verification_ref: verification.verification_id,
  });

  if (result === VERIFICATION_RESULT.PASS) {
    // Task becomes verified candidate-ready; never ACCEPTED by verifier alone.
    const taskRow = core.getTask(candidate.task_id);
    if (taskRow && taskRow.status !== TASK_STATUS.ACCEPTED) {
      core.updateTaskStatus(candidate.task_id, TASK_STATUS.VERIFIED);
    }
  }

  core.store.appendEvent({
    task_id: candidate.task_id,
    factory_run_id: candidate.factory_run_id,
    event_type: EVENT_TYPE.VERIFICATION_RECORDED,
    payload: {
      verification_id: verification.verification_id,
      candidate_id,
      commit_sha: sha,
      result,
      worker_claim_ignored_for_authority: true,
    },
  });

  return {
    result,
    verification,
    candidate: core.store.getCandidate(candidate_id),
    ci: ciSummary,
  };
}

export function invalidateVerification(core, verificationId, reason) {
  const v = core.store.getVerification(verificationId);
  if (!v) throw new VerifierError(`unknown verification_id: ${verificationId}`);
  const updated = core.store.updateVerification(verificationId, {
    invalidated_at: nowIso(),
    invalidation_reason: reason || 'invalidated',
  });
  core.store.appendEvent({
    task_id: core.store.getCandidate(v.candidate_id)?.task_id,
    event_type: EVENT_TYPE.VERIFICATION_INVALIDATED,
    payload: {
      verification_id: verificationId,
      commit_sha: v.commit_sha,
      reason,
    },
  });
  return updated;
}

export function isVerificationAuthoritative(core, verificationId) {
  const v = core.store.getVerification(verificationId);
  if (!v || v.invalidated_at) return false;
  if (v.result !== VERIFICATION_RESULT.PASS) return false;
  const candidate = core.store.getCandidate(v.candidate_id);
  if (!candidate) return false;
  if (candidate.commit_sha !== v.commit_sha) return false;
  if (candidate.status === CANDIDATE_STATUS.SUPERSEDED) return false;
  return true;
}
