// src/builder/core.js
// Builder Core — trusted software-work authority (Stage 1).
// Owns durable task/run/candidate/approval/event state and task locking.
// Does NOT own AgencyOS tenant/business authority or production credentials.

import {
  ACTIVE_RUN_STATUSES,
  CANDIDATE_STATUS,
  EVENT_TYPE,
  FAILURE_CLASS,
  RUN_STATUS,
  TASK_STATUS,
  TRUST_DOMAIN,
  assertCommitSha,
  newApprovalId,
  newCandidateId,
  newFactoryRunId,
} from './contracts.js';
import { openBuilderStore } from './store.js';
import {
  TaskLockError,
  assertTaskMutable,
  createAndLockTask,
  createDraftTask,
  lockTask,
  verifyTaskHash,
} from './task-lock.js';
import {
  PROVIDER_STATUS,
  assertWorkerProvider,
  normalizeProviderResult,
} from './worker-provider.js';

export class BuilderCoreError extends Error {
  constructor(reason, code = 'BUILDER_CORE_ERROR') {
    super(reason);
    this.name = 'BuilderCoreError';
    this.code = code;
    this.reason = reason;
  }
}

function mapProviderStatusToRunStatus(providerStatus) {
  switch (providerStatus) {
    case PROVIDER_STATUS.CREATING:
    case PROVIDER_STATUS.LAUNCHED:
      return RUN_STATUS.LAUNCHED;
    case PROVIDER_STATUS.RUNNING:
      return RUN_STATUS.RUNNING;
    case PROVIDER_STATUS.FINISHED:
      return RUN_STATUS.SUCCEEDED;
    case PROVIDER_STATUS.ERROR:
    case PROVIDER_STATUS.TIMEOUT:
    case PROVIDER_STATUS.EXPIRED:
      return RUN_STATUS.FAILED;
    case PROVIDER_STATUS.CANCELLED:
      return RUN_STATUS.CANCELLED;
    default:
      return RUN_STATUS.RUNNING;
  }
}

export class BuilderCore {
  constructor({ dbPath = ':memory:', store, workerProvider = null } = {}) {
    this.trustDomain = TRUST_DOMAIN.BUILDER_CORE;
    this.store = store || openBuilderStore(dbPath);
    this.workerProvider = workerProvider ? assertWorkerProvider(workerProvider) : null;
    // Stage-1: at most one authorized active coding run across the Builder.
    this._currentFactoryRunId = null;
  }

  close() {
    this.store.close();
  }

  // --- Task lifecycle (items 4–5) -----------------------------------------

  createDraftTask(ownerIntent) {
    return createDraftTask(this.store, ownerIntent);
  }

  lockTask(taskId) {
    return lockTask(this.store, taskId);
  }

  createAndLockTask(ownerIntent) {
    return createAndLockTask(this.store, ownerIntent);
  }

  getTask(taskId) {
    return this.store.getTask(taskId);
  }

  verifyLockedTask(taskId) {
    const task = this.store.getTask(taskId);
    verifyTaskHash(task);
    return task;
  }

  // Status transitions that do not mutate the locked finish line.
  updateTaskStatus(taskId, status) {
    const task = this.store.getTask(taskId);
    if (!task) throw new TaskLockError(`unknown task_id: ${taskId}`);
    if (task.status === TASK_STATUS.DRAFT && status !== TASK_STATUS.LOCKED) {
      throw new TaskLockError('draft task must be locked before other status changes');
    }
    verifyTaskHash(task);
    const updated = this.store.updateTask(taskId, { status });
    this.store.appendEvent({
      task_id: taskId,
      event_type: EVENT_TYPE.TASK_STATUS_CHANGED,
      payload: { from: task.status, to: status },
    });
    return updated;
  }

  // Reject attempts to rewrite locked acceptance / hash-binding fields.
  attemptMutateLockedTask(taskId, patch) {
    const task = this.store.getTask(taskId);
    assertTaskMutable(task, patch);
    return this.store.updateTask(taskId, patch);
  }

  // --- Durable subordinate records (item 4) -------------------------------

  createRun({
    task_id,
    provider,
    provider_run_id = null,
    provider_agent_id = null,
    attempt = null,
  }) {
    const task = this.store.getTask(task_id);
    if (!task) throw new TaskLockError(`unknown task_id: ${task_id}`);
    if (task.status === TASK_STATUS.DRAFT) {
      throw new TaskLockError('cannot create run for unlocked draft task');
    }
    verifyTaskHash(task);
    const existing = this.store.listRunsForTask(task_id);
    const nextAttempt = attempt ?? existing.length + 1;
    const run = this.store.insertRun({
      factory_run_id: newFactoryRunId(),
      task_id,
      provider,
      provider_run_id,
      provider_agent_id,
      attempt: nextAttempt,
      status: RUN_STATUS.PENDING,
      started_at: null,
      ended_at: null,
      failure_class: null,
      evidence: null,
    });
    this.store.appendEvent({
      task_id,
      factory_run_id: run.factory_run_id,
      event_type: EVENT_TYPE.RUN_CREATED,
      payload: { attempt: run.attempt, provider },
    });
    return run;
  }

  getRun(factoryRunId) {
    return this.store.getRun(factoryRunId);
  }

  getCurrentCodingRun() {
    if (this._currentFactoryRunId) {
      const current = this.store.getRun(this._currentFactoryRunId);
      if (current && ACTIVE_RUN_STATUSES.includes(current.status)) return current;
      this._currentFactoryRunId = null;
    }
    const active = this.store.listActiveRuns();
    if (active.length > 1) {
      throw new BuilderCoreError(
        `invariant broken: ${active.length} active coding runs`,
        'MULTIPLE_ACTIVE_RUNS'
      );
    }
    if (active[0]) this._currentFactoryRunId = active[0].factory_run_id;
    return active[0] || null;
  }

  assertAuthorizedRun(factoryRunId, { allowTerminalCurrent = false } = {}) {
    const run = this.store.getRun(factoryRunId);
    if (!run) {
      throw new BuilderCoreError(`unknown factory_run_id: ${factoryRunId}`, 'UNKNOWN_RUN');
    }
    const current = this.getCurrentCodingRun();
    if (current && current.factory_run_id !== factoryRunId) {
      this.store.appendEvent({
        task_id: run.task_id,
        factory_run_id: factoryRunId,
        event_type: EVENT_TYPE.STALE_RUN_REJECTED,
        payload: {
          rejected_factory_run_id: factoryRunId,
          current_factory_run_id: current.factory_run_id,
        },
      });
      throw new BuilderCoreError(
        `stale run rejected: ${factoryRunId} is not current authorized run ${current.factory_run_id}`,
        'STALE_RUN'
      );
    }
    if (!current && !allowTerminalCurrent) {
      // No active run: only the same factory_run_id may be inspected if it exists
      // and is not being used to mutate authoritative candidate/task state.
      if (run.status === RUN_STATUS.STALE) {
        throw new BuilderCoreError(
          `stale run rejected: ${factoryRunId}`,
          'STALE_RUN'
        );
      }
    }
    return run;
  }

  markRunStale(factoryRunId) {
    const run = this.store.getRun(factoryRunId);
    if (!run) throw new BuilderCoreError(`unknown factory_run_id: ${factoryRunId}`);
    const updated = this.store.updateRun(factoryRunId, {
      status: RUN_STATUS.STALE,
      ended_at: new Date().toISOString(),
      failure_class: FAILURE_CLASS.STALE_RUN,
    });
    if (this._currentFactoryRunId === factoryRunId) this._currentFactoryRunId = null;
    this.store.appendEvent({
      task_id: run.task_id,
      factory_run_id: factoryRunId,
      event_type: EVENT_TYPE.RUN_STATUS_CHANGED,
      payload: { to: RUN_STATUS.STALE },
    });
    return updated;
  }

  // --- WorkerProvider orchestration (items 6–8) ---------------------------

  async launchCodingWorker({ task_id, prompt, envVars = {} }) {
    if (!this.workerProvider) {
      throw new BuilderCoreError('no worker provider configured', 'NO_PROVIDER');
    }
    const existing = this.getCurrentCodingRun();
    if (existing) {
      throw new BuilderCoreError(
        `only one coding worker may be active; current=${existing.factory_run_id}`,
        'ACTIVE_WORKER_EXISTS'
      );
    }

    const task = this.verifyLockedTask(task_id);
    const run = this.createRun({
      task_id,
      provider: this.workerProvider.name,
    });
    this._currentFactoryRunId = run.factory_run_id;

    let providerResult;
    try {
      providerResult = normalizeProviderResult(
        await this.workerProvider.launch({
          factory_run_id: run.factory_run_id,
          task,
          prompt,
          envVars,
        })
      );
    } catch (err) {
      this.store.updateRun(run.factory_run_id, {
        status: RUN_STATUS.FAILED,
        ended_at: new Date().toISOString(),
        failure_class: FAILURE_CLASS.PROVIDER_ERROR,
        evidence: {
          error: {
            name: err.name,
            message: err.message,
            code: err.code || 'LAUNCH_FAILED',
            retryable: Boolean(err.retryable),
          },
        },
      });
      this._currentFactoryRunId = null;
      throw err;
    }

    if (providerResult.factory_run_id !== run.factory_run_id) {
      this.markRunStale(run.factory_run_id);
      throw new BuilderCoreError(
        'provider returned mismatched factory_run_id',
        'FACTORY_RUN_MISMATCH'
      );
    }

    const updated = this.store.updateRun(run.factory_run_id, {
      provider_run_id: providerResult.provider_run_id,
      provider_agent_id: providerResult.provider_agent_id,
      status: mapProviderStatusToRunStatus(providerResult.provider_status),
      started_at: new Date().toISOString(),
      evidence: providerResult.evidence,
    });
    this.updateTaskStatus(task_id, TASK_STATUS.RUNNING);
    this.store.appendEvent({
      task_id,
      factory_run_id: run.factory_run_id,
      event_type: EVENT_TYPE.WORKER_LAUNCHED,
      payload: {
        provider: providerResult.provider,
        provider_run_id: providerResult.provider_run_id,
        provider_agent_id: providerResult.provider_agent_id,
        provider_status: providerResult.provider_status,
      },
    });
    return { run: updated, provider_result: providerResult };
  }

  async refreshWorkerStatus(factoryRunId) {
    if (!this.workerProvider) {
      throw new BuilderCoreError('no worker provider configured', 'NO_PROVIDER');
    }
    const run = this.assertAuthorizedRun(factoryRunId);
    if (!run.provider_run_id || !run.provider_agent_id) {
      throw new BuilderCoreError('run missing provider mapping', 'MISSING_PROVIDER_MAPPING');
    }
    const providerResult = normalizeProviderResult(
      await this.workerProvider.status({
        factory_run_id: run.factory_run_id,
        provider_run_id: run.provider_run_id,
        provider_agent_id: run.provider_agent_id,
      })
    );
    return this._applyProviderObservation(run, providerResult, EVENT_TYPE.WORKER_STATUS);
  }

  async cancelCodingWorker(factoryRunId) {
    if (!this.workerProvider) {
      throw new BuilderCoreError('no worker provider configured', 'NO_PROVIDER');
    }
    const run = this.assertAuthorizedRun(factoryRunId);
    if (!run.provider_run_id || !run.provider_agent_id) {
      throw new BuilderCoreError('run missing provider mapping', 'MISSING_PROVIDER_MAPPING');
    }
    const providerResult = normalizeProviderResult(
      await this.workerProvider.cancel({
        factory_run_id: run.factory_run_id,
        provider_run_id: run.provider_run_id,
        provider_agent_id: run.provider_agent_id,
      })
    );
    const applied = this._applyProviderObservation(
      run,
      providerResult,
      EVENT_TYPE.WORKER_CANCELLED
    );
    this._currentFactoryRunId = null;
    return applied;
  }

  async collectCodingWorker(factoryRunId, { wait = false } = {}) {
    if (!this.workerProvider) {
      throw new BuilderCoreError('no worker provider configured', 'NO_PROVIDER');
    }
    const run = this.assertAuthorizedRun(factoryRunId, { allowTerminalCurrent: true });
    if (!run.provider_run_id || !run.provider_agent_id) {
      throw new BuilderCoreError('run missing provider mapping', 'MISSING_PROVIDER_MAPPING');
    }
    const providerResult = normalizeProviderResult(
      await this.workerProvider.collect({
        factory_run_id: run.factory_run_id,
        provider_run_id: run.provider_run_id,
        provider_agent_id: run.provider_agent_id,
        wait,
      })
    );
    // Collect evidence only. Never promote task to ACCEPTED/DONE here.
    const applied = this._applyProviderObservation(
      run,
      providerResult,
      EVENT_TYPE.WORKER_COLLECTED
    );
    if (!ACTIVE_RUN_STATUSES.includes(applied.run.status)) {
      this._currentFactoryRunId = null;
    }
    const task = this.store.getTask(run.task_id);
    return {
      ...applied,
      task_status: task.status,
      task_accepted: false,
    };
  }

  // Reject cancelled/stale provider returns that try to become authoritative later.
  applyProviderResult(factoryRunId, providerResult) {
    const run = this.store.getRun(factoryRunId);
    if (!run) {
      throw new BuilderCoreError(`unknown factory_run_id: ${factoryRunId}`, 'UNKNOWN_RUN');
    }
    if (run.status === RUN_STATUS.STALE || run.status === RUN_STATUS.CANCELLED) {
      this.store.appendEvent({
        task_id: run.task_id,
        factory_run_id: factoryRunId,
        event_type: EVENT_TYPE.STALE_RUN_REJECTED,
        payload: {
          rejected_factory_run_id: factoryRunId,
          run_status: run.status,
          provider_status: providerResult?.provider_status,
        },
      });
      throw new BuilderCoreError(
        `cancelled/stale run cannot become authoritative: ${factoryRunId}`,
        'STALE_RUN'
      );
    }
    const current = this.getCurrentCodingRun();
    if (current && current.factory_run_id !== factoryRunId) {
      this.store.appendEvent({
        task_id: run.task_id,
        factory_run_id: factoryRunId,
        event_type: EVENT_TYPE.STALE_RUN_REJECTED,
        payload: {
          rejected_factory_run_id: factoryRunId,
          current_factory_run_id: current.factory_run_id,
        },
      });
      throw new BuilderCoreError(
        `stale run rejected: ${factoryRunId}`,
        'STALE_RUN'
      );
    }
    return this._applyProviderObservation(
      run,
      normalizeProviderResult(providerResult),
      EVENT_TYPE.WORKER_STATUS
    );
  }

  _applyProviderObservation(run, providerResult, eventType) {
    if (providerResult.factory_run_id !== run.factory_run_id) {
      throw new BuilderCoreError(
        'provider factory_run_id mismatch',
        'FACTORY_RUN_MISMATCH'
      );
    }

    // CANCELLED/STALE are sticky local authority decisions. Provider lag that
    // still reports RUNNING must not revive them into an active coding run.
    const stickyTerminal = [RUN_STATUS.CANCELLED, RUN_STATUS.STALE].includes(run.status);
    const mapped = mapProviderStatusToRunStatus(providerResult.provider_status);
    const nextStatus = stickyTerminal ? run.status : mapped;
    const failure_class = stickyTerminal
      ? run.failure_class
      : providerResult.provider_status === PROVIDER_STATUS.TIMEOUT
        ? FAILURE_CLASS.TIMEOUT
        : providerResult.provider_status === PROVIDER_STATUS.ERROR
          ? FAILURE_CLASS.PROVIDER_ERROR
          : run.failure_class;
    const updated = this.store.updateRun(run.factory_run_id, {
      provider_run_id: providerResult.provider_run_id ?? run.provider_run_id,
      provider_agent_id: providerResult.provider_agent_id ?? run.provider_agent_id,
      status: nextStatus,
      ended_at: ACTIVE_RUN_STATUSES.includes(nextStatus)
        ? null
        : (run.ended_at || new Date().toISOString()),
      failure_class,
      evidence: {
        ...(run.evidence || {}),
        ...(providerResult.evidence || {}),
        last_provider_status: providerResult.provider_status,
        last_provider_error: providerResult.error,
      },
    });
    if (!ACTIVE_RUN_STATUSES.includes(updated.status) &&
        this._currentFactoryRunId === run.factory_run_id) {
      this._currentFactoryRunId = null;
    }
    this.store.appendEvent({
      task_id: run.task_id,
      factory_run_id: run.factory_run_id,
      event_type: eventType,
      payload: {
        provider_status: providerResult.provider_status,
        provider_run_id: providerResult.provider_run_id,
        provider_agent_id: providerResult.provider_agent_id,
        error: providerResult.error,
        local_run_status: updated.status,
      },
    });
    return { run: updated, provider_result: providerResult };
  }

  recordCandidate({
    task_id,
    factory_run_id,
    branch,
    commit_sha,
    pr_ref = null,
    verification_ref = null,
    review_ref = null,
    ci_ref = null,
  }) {
    const task = this.store.getTask(task_id);
    if (!task) throw new TaskLockError(`unknown task_id: ${task_id}`);
    verifyTaskHash(task);
    const run = this.store.getRun(factory_run_id);
    if (!run || run.task_id !== task_id) {
      throw new TaskLockError('factory_run_id does not belong to task');
    }
    if (run.status === RUN_STATUS.STALE || run.status === RUN_STATUS.CANCELLED) {
      this.store.appendEvent({
        task_id,
        factory_run_id,
        event_type: EVENT_TYPE.STALE_RUN_REJECTED,
        payload: { reason: 'candidate_from_cancelled_or_stale_run', status: run.status },
      });
      throw new BuilderCoreError(
        `cancelled/stale run cannot become authoritative: ${factory_run_id}`,
        'STALE_RUN'
      );
    }
    const current = this.getCurrentCodingRun();
    if (current && current.factory_run_id !== factory_run_id) {
      this.store.appendEvent({
        task_id,
        factory_run_id,
        event_type: EVENT_TYPE.STALE_RUN_REJECTED,
        payload: {
          rejected_factory_run_id: factory_run_id,
          current_factory_run_id: current.factory_run_id,
        },
      });
      throw new BuilderCoreError(
        `stale run rejected: ${factory_run_id}`,
        'STALE_RUN'
      );
    }
    const candidate = this.store.insertCandidate({
      candidate_id: newCandidateId(),
      task_id,
      factory_run_id,
      branch,
      commit_sha: commit_sha ? assertCommitSha(commit_sha) : null,
      pr_ref,
      verification_ref,
      review_ref,
      ci_ref,
      status: CANDIDATE_STATUS.PROPOSED,
    });
    this.store.appendEvent({
      task_id,
      factory_run_id,
      event_type: EVENT_TYPE.CANDIDATE_RECORDED,
      payload: {
        candidate_id: candidate.candidate_id,
        commit_sha: candidate.commit_sha,
        branch: candidate.branch,
      },
    });
    return candidate;
  }

  // Stage-1 storage for approval records bound to proposal_id + content_hash.
  // Full approval-invalidation policy wiring is a later build-order item.
  recordApproval({
    task_id,
    approved_by,
    candidate_id = null,
    commit_sha = null,
    status = 'APPROVED',
  }) {
    const task = this.store.getTask(task_id);
    if (!task) throw new TaskLockError(`unknown task_id: ${task_id}`);
    verifyTaskHash(task);
    if (!task.proposal_id || !task.content_hash) {
      throw new TaskLockError('approval requires locked proposal_id + content_hash');
    }
    if (commit_sha) assertCommitSha(commit_sha);
    const approval = this.store.insertApproval({
      approval_id: newApprovalId(),
      task_id,
      proposal_id: task.proposal_id,
      content_hash: task.content_hash,
      candidate_id,
      commit_sha,
      approved_by,
      status,
    });
    this.store.appendEvent({
      task_id,
      event_type: EVENT_TYPE.APPROVAL_RECORDED,
      payload: {
        approval_id: approval.approval_id,
        proposal_id: approval.proposal_id,
        content_hash: approval.content_hash,
        candidate_id,
        commit_sha,
      },
    });
    return approval;
  }

  reconstruct() {
    return this.store.reconstruct();
  }
}

export function createBuilderCore(options) {
  return new BuilderCore(options);
}
