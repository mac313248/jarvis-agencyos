// Restart / recovery reconciliation for Builder Stage 1.
// Reconstructs authoritative nonterminal state. Ambiguous state fails closed.
// Never relaunches workers. Stale/cancelled runs remain fenced.

import {
  ACTIVE_RUN_STATUSES,
  APPROVAL_STATUS,
  CANDIDATE_STATUS,
  EVENT_TYPE,
  RUN_STATUS,
  TASK_STATUS,
} from './contracts.js';
import { BuilderCoreError } from './errors.js';
import { verifyTaskHash } from './task-lock.js';
import { isVerificationAuthoritative } from './verifier.js';
import { isReviewAuthoritative } from './codex-review.js';
import { countAttempts, resolveRetryPolicy } from './retry.js';
import { getAllowedToolManifest } from './tool-policy.js';
import { detectAwaitingCi } from './ci-wait.js';
import { settle, co } from './thenable.js';

const TERMINAL_TASK_STATUSES = new Set([
  TASK_STATUS.ACCEPTED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
]);

function nowIso() {
  return new Date().toISOString();
}

function currentCandidateForTask(store, taskId) {
  return co(function* () {
    const candidates = yield store.listCandidatesForTask(taskId);
    const live = candidates.filter((c) => c.status !== CANDIDATE_STATUS.SUPERSEDED);
    if (live.length > 1) {
      const verified = live.filter((c) => c.status === CANDIDATE_STATUS.VERIFIED);
      if (verified.length > 1) {
        return {
          error: 'MULTIPLE_VERIFIED_CANDIDATES',
          message: `task ${taskId} has ${verified.length} VERIFIED candidates`,
        };
      }
      if (verified.length === 1) return { candidate: verified[0] };
      // Multiple non-superseded non-verified: prefer newest by created_at.
      const sorted = [...live].sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at))
      );
      if (sorted.length > 1 && sorted[0].created_at === sorted[1].created_at) {
        return {
          error: 'AMBIGUOUS_CANDIDATE',
          message: `task ${taskId} has ambiguous current candidates`,
        };
      }
      return { candidate: sorted[0] || null };
    }
    return { candidate: live[0] || null };
  });
}

function currentApprovalForTask(store, taskId) {
  return co(function* () {
    const approvals = yield store.listApprovalsForTask(taskId);
    const live = approvals.filter(
      (a) =>
        a.status !== APPROVAL_STATUS.INVALIDATED &&
        a.status !== APPROVAL_STATUS.REJECTED
    );
    if (live.length > 1) {
      const approved = live.filter((a) => a.status === APPROVAL_STATUS.APPROVED);
      if (approved.length > 1) {
        return {
          error: 'MULTIPLE_APPROVALS',
          message: `task ${taskId} has multiple non-invalidated approvals`,
        };
      }
      return { approval: approved[0] || live[0] };
    }
    return { approval: live[0] || null };
  });
}

function buildTaskRecoverySnapshot(core, task) {
  return co(function* () {
    try {
      verifyTaskHash(task);
    } catch (err) {
      return {
        task_id: task.task_id,
        status: 'BLOCKED',
        reason: 'CONTENT_HASH_MISMATCH',
        message: err.message,
        task: null,
      };
    }

    const runs = yield core.store.listRunsForTask(task.task_id);
    const activeRuns = runs.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status));
    if (activeRuns.length > 1) {
      return {
        task_id: task.task_id,
        status: 'BLOCKED',
        reason: 'MULTIPLE_ACTIVE_RUNS_FOR_TASK',
        message: `task ${task.task_id} has ${activeRuns.length} active runs`,
        task,
      };
    }

    const candResult = yield currentCandidateForTask(core.store, task.task_id);
    if (candResult.error) {
      return {
        task_id: task.task_id,
        status: 'BLOCKED',
        reason: candResult.error,
        message: candResult.message,
        task,
      };
    }

    const candidate = candResult.candidate;
    let verification = null;
    let review = null;
    if (candidate?.verification_ref) {
      verification = yield core.store.getVerification(candidate.verification_ref);
      if (!verification) {
        return {
          task_id: task.task_id,
          status: 'BLOCKED',
          reason: 'MISSING_VERIFICATION_REF',
          message: `candidate ${candidate.candidate_id} verification_ref missing`,
          task,
          candidate,
        };
      }
    }
    if (candidate?.review_ref) {
      review = yield core.store.getReview(candidate.review_ref);
      if (!review) {
        return {
          task_id: task.task_id,
          status: 'BLOCKED',
          reason: 'MISSING_REVIEW_REF',
          message: `candidate ${candidate.candidate_id} review_ref missing`,
          task,
          candidate,
        };
      }
    }

    const apprResult = yield currentApprovalForTask(core.store, task.task_id);
    if (apprResult.error) {
      return {
        task_id: task.task_id,
        status: 'BLOCKED',
        reason: apprResult.error,
        message: apprResult.message,
        task,
        candidate,
      };
    }

    const retry = resolveRetryPolicy(task);
    const attempts = yield countAttempts(core, task.task_id);
    const awaitingCi = yield detectAwaitingCi(core, task.task_id);

    return {
      task_id: task.task_id,
      status: 'OK',
      task,
      allowed_tool_manifest: getAllowedToolManifest(task),
      current_factory_run_id: activeRuns[0]?.factory_run_id || null,
      active_run: activeRuns[0] || null,
      runs,
      candidate,
      verification,
      verification_authoritative: verification
        ? yield isVerificationAuthoritative(core, verification.verification_id)
        : false,
      review,
      review_authoritative: review
        ? yield isReviewAuthoritative(core, review.review_id)
        : false,
      approval: apprResult.approval,
      awaiting_ci: Boolean(awaitingCi.awaiting_ci),
      resume_without_worker_launch: Boolean(awaitingCi.awaiting_ci),
      retry: {
        max_attempts: retry.max_attempts,
        max_runtime_ms: retry.max_runtime_ms,
        cost_budget_status: retry.cost_budget.status,
        attempts,
      },
    };
  });
}

/**
 * Reconcile Builder Core after process restart.
 * Does not launch workers. Provider status may be read-only reconciled.
 */
export async function reconcileAfterRestart(core, {
  reconcileProviderStatus = null,
} = {}) {
  const active = await settle(core.store.listActiveRuns());
  if (active.length > 1) {
    const blocked = {
      status: 'BLOCKED',
      reason: 'MULTIPLE_ACTIVE_RUNS',
      message: `ambiguous recovery: ${active.length} active coding runs`,
      current_factory_run_id: null,
      tasks: [],
      active_runs: active,
    };
    await settle(core.store.appendEvent({
      event_type: EVENT_TYPE.RECOVERY_BLOCKED,
      payload: blocked,
    }));
    core._currentFactoryRunId = null;
    core._recovery = blocked;
    return blocked;
  }

  if (active.length === 1) {
    core._currentFactoryRunId = active[0].factory_run_id;
  } else {
    core._currentFactoryRunId = null;
  }

  let provider_status = null;
  if (
    active[0] &&
    typeof reconcileProviderStatus === 'function' &&
    active[0].provider_run_id
  ) {
    try {
      provider_status = await reconcileProviderStatus({
        factory_run_id: active[0].factory_run_id,
        provider_run_id: active[0].provider_run_id,
        provider_agent_id: active[0].provider_agent_id,
        read_only: true,
      });
    } catch (err) {
      provider_status = {
        ok: false,
        error: {
          code: err.code || 'PROVIDER_STATUS_UNAVAILABLE',
          message: String(err.message || err),
        },
      };
    }
  }

  const allTasks = await settle(core.store.listTasks());
  const tasks = allTasks.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status));

  const snapshots = [];
  for (const t of tasks) {
    snapshots.push(await settle(buildTaskRecoverySnapshot(core, t)));
  }
  const blockedTasks = snapshots.filter((s) => s.status === 'BLOCKED');

  for (const task of tasks) {
    const runs = await settle(core.store.listRunsForTask(task.task_id));
    for (const run of runs) {
      if (
        (run.status === RUN_STATUS.STALE || run.status === RUN_STATUS.CANCELLED) &&
        core._currentFactoryRunId === run.factory_run_id
      ) {
        core._currentFactoryRunId = null;
      }
    }
  }

  if (blockedTasks.length) {
    const blocked = {
      status: 'BLOCKED',
      reason: 'TASK_RECOVERY_AMBIGUOUS',
      message: 'one or more nonterminal tasks failed closed during recovery',
      current_factory_run_id: core._currentFactoryRunId,
      provider_status,
      tasks: snapshots,
      recovered_at: nowIso(),
    };
    await settle(core.store.appendEvent({
      event_type: EVENT_TYPE.RECOVERY_BLOCKED,
      payload: {
        reason: blocked.reason,
        blocked_task_ids: blockedTasks.map((t) => t.task_id),
      },
    }));
    core._recovery = blocked;
    return blocked;
  }

  const ok = {
    status: 'OK',
    reason: null,
    current_factory_run_id: core._currentFactoryRunId,
    provider_status,
    tasks: snapshots,
    recovered_at: nowIso(),
    duplicate_launch_prevented: true,
  };
  await settle(core.store.appendEvent({
    event_type: EVENT_TYPE.RECOVERY_RECONCILED,
    payload: {
      current_factory_run_id: ok.current_factory_run_id,
      task_ids: snapshots.map((s) => s.task_id),
      recovered_at: ok.recovered_at,
    },
  }));
  core._recovery = ok;
  return ok;
}

export function reconstructAuthoritativeState(core) {
  return co(function* () {
    const base = yield core.store.reconstruct();
    const active = yield core.store.listActiveRuns();
    const nonterminal = base.nonterminal_tasks || [];
    const task_snapshots = [];
    for (const t of nonterminal) {
      task_snapshots.push(yield buildTaskRecoverySnapshot(core, t));
    }

    return {
      ...base,
      current_factory_run_id:
        active.length === 1 ? active[0].factory_run_id : null,
      active_runs: active,
      ambiguous_active_runs: active.length > 1,
      task_snapshots,
      recovery: core._recovery || null,
    };
  });
}

export function assertNoDuplicateLaunchAfterRecovery(core) {
  return co(function* () {
    const active = yield core.store.listActiveRuns();
    if (active.length > 1) {
      throw new BuilderCoreError(
        `recovery invariant broken: ${active.length} active coding runs`,
        'MULTIPLE_ACTIVE_RUNS'
      );
    }
    if (active.length === 1) {
      if (core._currentFactoryRunId !== active[0].factory_run_id) {
        throw new BuilderCoreError(
          'recovery current_factory_run_id does not match durable active run',
          'RECOVERY_POINTER_MISMATCH'
        );
      }
    }
    return true;
  });
}
