// Deterministic Stage-1 verifier.
// Verifies the EXACT candidate commit_sha. Worker self-certification is void.
// PASS requires GitHub landing truth: exact commit + PR/branch + completed CI success.

import {
  CANDIDATE_STATUS,
  EVENT_TYPE,
  FAILURE_CLASS,
  TASK_STATUS,
  VERIFICATION_RESULT,
  assertCommitSha,
  newId,
} from './contracts.js';
import { co, settle } from './thenable.js';

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

function invalidatePriorVerifications(core, candidateId, reason) {
  return co(function* () {
    const prior = yield core.store.listVerificationsForCandidate(candidateId);
    for (const v of prior) {
      if (v.invalidated_at) continue;
      yield invalidateVerification(core, v.verification_id, reason);
    }
  });
}

function invalidatePriorReviews(core, candidateId, reason) {
  return co(function* () {
    const prior = yield core.store.listReviewsForCandidate(candidateId);
    for (const r of prior) {
      if (r.invalidated_at) continue;
      // Prefer core wrapper when present to avoid circular imports with codex-review.
      if (typeof core.invalidateReview === 'function') {
        yield core.invalidateReview(r.review_id, reason);
      } else {
        yield core.store.updateReview(r.review_id, {
          invalidated_at: nowIso(),
          invalidation_reason: reason || 'invalidated',
        });
      }
    }
    const candidate = yield core.store.getCandidate(candidateId);
    if (candidate?.review_ref) {
      yield core.store.updateCandidate(candidateId, { review_ref: null });
    }
  });
}

/**
 * Deterministic verification profile for one exact candidate SHA.
 * GitHub landing evidence is mandatory for PASS.
 */
export async function verifyExactCandidate({
  core,
  candidate_id,
  githubClient = null,
  runTaskTests = null,
  runBuildChecks = null,
  worker_claim = null,
}) {
  const candidate = await settle(core.store.getCandidate(candidate_id));
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

  const run = await settle(core.store.getRun(candidate.factory_run_id));
  if (!run) {
    throw new VerifierError('candidate factory_run_id missing', 'MISSING_RUN');
  }
  if (run.status === 'STALE' || run.status === 'CANCELLED') {
    await settle(core.store.appendEvent({
      task_id: candidate.task_id,
      factory_run_id: candidate.factory_run_id,
      event_type: EVENT_TYPE.STALE_RUN_REJECTED,
      payload: {
        reason: 'verify_from_cancelled_or_stale_run',
        status: run.status,
        candidate_id,
      },
    }));
    throw new VerifierError(
      `cancelled/stale run cannot authorize candidate: ${candidate.factory_run_id}`,
      'STALE_RUN'
    );
  }

  // Re-verification or landing-evidence refresh must invalidate prior authority.
  await settle(invalidatePriorVerifications(
    core,
    candidate_id,
    're-verification_or_landing_evidence_change'
  ));
  await settle(invalidatePriorReviews(
    core,
    candidate_id,
    're-verification_or_landing_evidence_change'
  ));

  const sha = assertCommitSha(candidate.commit_sha);
  const task = await settle(core.getTask(candidate.task_id));
  const checks = [];
  let landingSnapshot = null;
  let ciSummary = null;

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

  // GitHub landing truth is mandatory for PASS. Fail closed on absence/errors.
  if (!githubClient) {
    checks.push({
      name: 'github_landing',
      ok: null,
      authoritative: true,
      detail: 'githubClient required for exact commit/PR/branch/CI validation',
    });
    checks.push({
      name: 'github_ci',
      ok: null,
      authoritative: true,
      detail: 'github CI unavailable without githubClient',
    });
  } else {
    try {
      const commit = await githubClient.getCommit(sha);
      if (!commit?.sha || commit.sha !== sha) {
        throw new VerifierError(
          `github commit sha mismatch: expected ${sha} got ${commit?.sha}`,
          'SHA_MISMATCH'
        );
      }

      if (!candidate.branch) {
        throw new VerifierError('candidate missing branch for PR binding', 'MISSING_BRANCH');
      }

      let prNumber = candidate.pr_number;
      if (prNumber == null) {
        const found = await githubClient.findPullRequestsForHead(candidate.branch);
        if (!found?.[0]?.number) {
          throw new VerifierError(
            'candidate requires a GitHub PR bound to branch/SHA',
            'MISSING_PR'
          );
        }
        prNumber = found[0].number;
      }

      const pr = await githubClient.getPullRequest(prNumber);
      if (pr.head_sha !== sha) {
        throw new VerifierError(
          `PR #${prNumber} head ${pr.head_sha} does not match candidate sha ${sha}`,
          'PR_SHA_MISMATCH'
        );
      }
      if (pr.head_ref !== candidate.branch) {
        throw new VerifierError(
          `PR #${prNumber} head_ref ${pr.head_ref} does not match candidate branch ${candidate.branch}`,
          'PR_BRANCH_MISMATCH'
        );
      }

      const checkRuns = await githubClient.getCheckRunsForCommit(sha);
      const combined = await githubClient.getCombinedStatusForCommit(sha);
      ciSummary = githubClient.summarizeCi({
        checkRuns,
        combinedStatus: combined,
      });

      landingSnapshot = {
        commit_sha: sha,
        branch: candidate.branch,
        pr_number: pr.number,
        pr_url: pr.html_url,
        pr_head_ref: pr.head_ref,
        pr_head_sha: pr.head_sha,
        ci_status: ciSummary.ci_status,
        ci_conclusion: ciSummary.ci_conclusion,
        combined_state: ciSummary.combined_state,
        checks: ciSummary.checks,
        captured_at: ciSummary.captured_at,
      };

      await settle(core.store.updateCandidate(candidate_id, {
        pr_number: pr.number,
        pr_url: pr.html_url,
        pr_ref: String(pr.number),
        ci_status: ciSummary.ci_status,
        ci_conclusion: ciSummary.ci_conclusion,
        ci_ref: JSON.stringify(landingSnapshot),
        evidence_at: ciSummary.captured_at,
      }));

      checks.push({
        name: 'github_landing',
        ok: true,
        authoritative: true,
        detail: JSON.stringify({
          commit_sha: sha,
          branch: candidate.branch,
          pr_number: pr.number,
          pr_head_ref: pr.head_ref,
        }),
      });

      const ciOk =
        ciSummary.ci_status === 'completed' && ciSummary.ci_conclusion === 'success'
          ? true
          : ciSummary.ci_conclusion === 'failure'
            ? false
            : null;
      checks.push({
        name: 'github_ci',
        ok: ciOk,
        authoritative: true,
        detail: JSON.stringify({
          ci_status: ciSummary.ci_status,
          ci_conclusion: ciSummary.ci_conclusion,
          combined_state: ciSummary.combined_state,
        }),
      });
    } catch (err) {
      const code = err?.code || 'GITHUB_LANDING_ERROR';
      const hardMismatch = [
        'SHA_MISMATCH',
        'PR_SHA_MISMATCH',
        'PR_BRANCH_MISMATCH',
      ].includes(code);
      checks.push({
        name: 'github_landing',
        ok: hardMismatch ? false : null,
        authoritative: true,
        detail: `${code}: ${err.message}`,
      });
      checks.push({
        name: 'github_ci',
        ok: null,
        authoritative: true,
        detail: `ci_unavailable_after_landing_error: ${err.message}`,
      });
    }
  }

  const authoritative = checks.filter((c) => c.authoritative);
  const hardFails = authoritative.filter((c) => c.ok === false);
  const unknowns = authoritative.filter((c) => c.ok == null);
  const hardPasses = authoritative.filter((c) => c.ok === true);
  const landingPass = authoritative.some(
    (c) => c.name === 'github_landing' && c.ok === true
  );
  const ciPass = authoritative.some(
    (c) => c.name === 'github_ci' && c.ok === true
  );

  let result = VERIFICATION_RESULT.PASS;
  let failure_class = null;
  if (hardFails.length) {
    result = VERIFICATION_RESULT.FAIL;
    failure_class = hardFails.some((c) => c.name.startsWith('github_'))
      ? FAILURE_CLASS.CI_FAIL
      : FAILURE_CLASS.TEST_FAIL;
  } else if (!landingPass || !ciPass || unknowns.length) {
    // Missing client, fetch error, absent PR, pending/unknown CI => BLOCKED.
    result = VERIFICATION_RESULT.BLOCKED;
  } else if (!hardPasses.length) {
    result = VERIFICATION_RESULT.BLOCKED;
  }

  // Local task/build passes alone can never authorize without GitHub landing+CI.
  if (result === VERIFICATION_RESULT.PASS && (!landingPass || !ciPass)) {
    result = VERIFICATION_RESULT.BLOCKED;
  }

  const verification = await settle(core.store.insertVerification({
    verification_id: newId('ver'),
    candidate_id,
    commit_sha: sha,
    result,
    checks: [
      ...checks,
      ...(landingSnapshot
        ? [
            {
              name: 'landing_evidence_snapshot',
              ok: result === VERIFICATION_RESULT.PASS,
              authoritative: false,
              detail: JSON.stringify(landingSnapshot),
            },
          ]
        : []),
    ],
    worker_claim: worker_claim == null ? null : String(worker_claim),
    failure_class,
    created_at: nowIso(),
  }));

  const nextCandidateStatus =
    result === VERIFICATION_RESULT.PASS
      ? CANDIDATE_STATUS.VERIFIED
      : result === VERIFICATION_RESULT.FAIL
        ? CANDIDATE_STATUS.REJECTED
        : CANDIDATE_STATUS.VERIFYING;

  await settle(core.store.updateCandidate(candidate_id, {
    status: nextCandidateStatus,
    verification_ref: verification.verification_id,
  }));

  if (result === VERIFICATION_RESULT.PASS) {
    // Task becomes verified candidate-ready; never ACCEPTED by verifier alone.
    const taskRow = await settle(core.getTask(candidate.task_id));
    if (taskRow && taskRow.status !== TASK_STATUS.ACCEPTED) {
      await settle(core.updateTaskStatus(candidate.task_id, TASK_STATUS.VERIFIED));
    }
  }

  await settle(core.store.appendEvent({
    task_id: candidate.task_id,
    factory_run_id: candidate.factory_run_id,
    event_type: EVENT_TYPE.VERIFICATION_RECORDED,
    payload: {
      verification_id: verification.verification_id,
      candidate_id,
      commit_sha: sha,
      result,
      worker_claim_ignored_for_authority: true,
      landing_required: true,
    },
  }));

  return {
    result,
    verification,
    candidate: await settle(core.store.getCandidate(candidate_id)),
    ci: ciSummary,
    landing: landingSnapshot,
  };
}

export function invalidateVerification(core, verificationId, reason) {
  return co(function* () {
    const v = yield core.store.getVerification(verificationId);
    if (!v) throw new VerifierError(`unknown verification_id: ${verificationId}`);
    if (v.invalidated_at) return v;
    const updated = yield core.store.updateVerification(verificationId, {
      invalidated_at: nowIso(),
      invalidation_reason: reason || 'invalidated',
    });
    const candidate = yield core.store.getCandidate(v.candidate_id);
    yield core.store.appendEvent({
      task_id: candidate?.task_id,
      event_type: EVENT_TYPE.VERIFICATION_INVALIDATED,
      payload: {
        verification_id: verificationId,
        commit_sha: v.commit_sha,
        reason,
      },
    });
    return updated;
  });
}

function landingSnapshotFromVerification(verification) {
  const checks = Array.isArray(verification?.checks) ? verification.checks : [];
  const row = checks.find((c) => c?.name === 'landing_evidence_snapshot');
  if (!row?.detail) return null;
  try {
    return typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
  } catch {
    return null;
  }
}

export function isVerificationAuthoritative(core, verificationId) {
  return co(function* () {
    const v = yield core.store.getVerification(verificationId);
    if (!v || v.invalidated_at) return false;
    if (v.result !== VERIFICATION_RESULT.PASS) return false;
    const candidate = yield core.store.getCandidate(v.candidate_id);
    if (!candidate) return false;
    if (candidate.status !== CANDIDATE_STATUS.VERIFIED) return false;
    if (candidate.verification_ref !== verificationId) return false;
    if (candidate.commit_sha !== v.commit_sha) return false;

    // Authority is bound to the immutable landing evidence snapshot captured at PASS.
    const snap = landingSnapshotFromVerification(v);
    if (!snap) return false;
    if (snap.commit_sha !== candidate.commit_sha) return false;
    if (snap.branch !== candidate.branch) return false;
    if (Number(snap.pr_number) !== Number(candidate.pr_number)) return false;
    if (snap.ci_status !== candidate.ci_status) return false;
    if (snap.ci_conclusion !== candidate.ci_conclusion) return false;
    return true;
  });
}
