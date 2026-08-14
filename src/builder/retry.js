// Bounded retry/repair for Builder Stage 1.
// Fresh factory_run_id per attempt. No scheduler. No infinite retry.

import {
  EVENT_TYPE,
  FAILURE_CLASS,
  RUN_STATUS,
  TASK_STATUS,
} from './contracts.js';
import { BuilderCoreError } from './errors.js';
import { co } from './thenable.js';

export const DEFAULT_RETRY_POLICY = Object.freeze({
  max_attempts: 2,
  max_runtime_ms: 30 * 60 * 1000,
  // Cost budget is not yet trustworthily available from all providers.
  cost_budget: Object.freeze({
    supported: false,
    status: 'UNKNOWN',
  }),
});

export const NON_RETRYABLE_FAILURE_CLASSES = Object.freeze([
  FAILURE_CLASS.ACCEPTANCE_TAMPER,
  FAILURE_CLASS.POLICY_VIOLATION,
]);

export function resolveRetryPolicy(task = {}) {
  return {
    max_attempts:
      task.max_attempts == null
        ? DEFAULT_RETRY_POLICY.max_attempts
        : Number(task.max_attempts),
    max_runtime_ms:
      task.max_runtime_ms == null
        ? DEFAULT_RETRY_POLICY.max_runtime_ms
        : Number(task.max_runtime_ms),
    cost_budget: {
      supported: false,
      status: task.cost_budget_status || 'UNKNOWN',
    },
  };
}

export function isRetryableFailureClass(failureClass) {
  if (!failureClass) return true;
  return !NON_RETRYABLE_FAILURE_CLASSES.includes(failureClass);
}

export function countAttempts(core, taskId) {
  return co(function* () {
    const runs = yield core.store.listRunsForTask(taskId);
    return runs.length;
  });
}

export function elapsedRuntimeMs(core, taskId) {
  return co(function* () {
    const runs = yield core.store.listRunsForTask(taskId);
    return elapsedRuntimeMsFromRuns(runs);
  });
}

/**
 * Begin a bounded repair attempt: closes current active run and mints a fresh
 * factory_run_id. Exhausted/non-retryable failures become BLOCKED/NEEDS_OWNER.
 */
export function beginRepairAttempt(
  core,
  taskId,
  {
    failure_class = FAILURE_CLASS.UNKNOWN,
    reason = 'repair',
    provider = 'cursor',
  } = {}
) {
  return co(function* () {
    const task = yield core.getTask(taskId);
    if (!task) {
      throw new BuilderCoreError(`unknown task_id: ${taskId}`, 'UNKNOWN_TASK');
    }
    const policy = resolveRetryPolicy(task);

    if (!isRetryableFailureClass(failure_class)) {
      const updated = yield core.updateTaskStatus(taskId, TASK_STATUS.BLOCKED);
      yield core.store.appendEvent({
        task_id: taskId,
        event_type: EVENT_TYPE.RETRY_DENIED,
        payload: {
          reason: 'non_retryable_failure_class',
          failure_class,
        },
      });
      return {
        allowed: false,
        task: updated,
        stop_status: TASK_STATUS.BLOCKED,
        failure_class,
        reason: 'non_retryable_failure_class',
      };
    }

    const runs = yield core.store.listRunsForTask(taskId);
    const attempts = runs.length;
    if (attempts >= policy.max_attempts) {
      const updated = yield core.updateTaskStatus(taskId, TASK_STATUS.NEEDS_OWNER);
      yield core.store.appendEvent({
        task_id: taskId,
        event_type: EVENT_TYPE.RETRY_EXHAUSTED,
        payload: {
          attempts,
          max_attempts: policy.max_attempts,
          failure_class,
          reason: 'attempt_cap',
        },
      });
      return {
        allowed: false,
        task: updated,
        stop_status: TASK_STATUS.NEEDS_OWNER,
        failure_class: FAILURE_CLASS.ATTEMPT_CAP,
        reason: 'attempt_cap',
        attempts,
        policy,
      };
    }

    const runtimeMs = elapsedRuntimeMsFromRuns(runs);
    if (runtimeMs >= policy.max_runtime_ms) {
      const updated = yield core.updateTaskStatus(taskId, TASK_STATUS.BLOCKED);
      yield core.store.appendEvent({
        task_id: taskId,
        event_type: EVENT_TYPE.RETRY_EXHAUSTED,
        payload: {
          runtime_ms: runtimeMs,
          max_runtime_ms: policy.max_runtime_ms,
          failure_class: FAILURE_CLASS.TIMEOUT,
          reason: 'runtime_cap',
        },
      });
      return {
        allowed: false,
        task: updated,
        stop_status: TASK_STATUS.BLOCKED,
        failure_class: FAILURE_CLASS.TIMEOUT,
        reason: 'runtime_cap',
        runtime_ms: runtimeMs,
        policy,
      };
    }

    if (policy.cost_budget.status === 'TRACKED' && policy.cost_budget.supported) {
      // Reserved for a future trustworthy cost source.
    }

    const current = yield core.getCurrentCodingRun();
    if (current && current.task_id === taskId) {
      yield core.store.updateRun(current.factory_run_id, {
        status: RUN_STATUS.FAILED,
        ended_at: new Date().toISOString(),
        failure_class,
        evidence: {
          ...(current.evidence || {}),
          repair_reason: reason,
        },
      });
      if (core._currentFactoryRunId === current.factory_run_id) {
        core._currentFactoryRunId = null;
      }
      yield core.store.appendEvent({
        task_id: taskId,
        factory_run_id: current.factory_run_id,
        event_type: EVENT_TYPE.RUN_STATUS_CHANGED,
        payload: { to: RUN_STATUS.FAILED, failure_class, reason },
      });
    }

    const fresh = yield core.createRun({
      task_id: taskId,
      provider,
    });
    core._currentFactoryRunId = fresh.factory_run_id;
    if (task.status !== TASK_STATUS.RUNNING) {
      yield core.updateTaskStatus(taskId, TASK_STATUS.RUNNING);
    }
    yield core.store.appendEvent({
      task_id: taskId,
      factory_run_id: fresh.factory_run_id,
      event_type: EVENT_TYPE.RETRY_STARTED,
      payload: {
        previous_attempts: attempts,
        next_attempt: fresh.attempt,
        failure_class,
        reason,
        cost_budget: policy.cost_budget,
      },
    });

    return {
      allowed: true,
      run: fresh,
      task: yield core.getTask(taskId),
      attempts_before: attempts,
      policy,
      failure_class,
    };
  });
}

function elapsedRuntimeMsFromRuns(runs) {
  let total = 0;
  for (const run of runs) {
    if (!run.started_at) continue;
    const end = run.ended_at ? Date.parse(run.ended_at) : Date.now();
    const start = Date.parse(run.started_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      total += end - start;
    }
  }
  return total;
}
