// src/builder/core.js
// Builder Core — trusted software-work authority (Stage 1).
// Owns durable task/run/candidate/approval/event state and task locking.
// Does NOT own AgencyOS tenant/business authority or production credentials.

import {
  ACTIVE_RUN_STATUSES,
  EVENT_TYPE,
  FAILURE_CLASS,
  RUN_STATUS,
  TASK_STATUS,
  TRUST_DOMAIN,
  assertCommitSha,
  newApprovalId,
  newFactoryRunId,
} from './contracts.js';
import { openBuilderStore } from './store.js';
import { co, settle } from './thenable.js';
import { isUniqueViolation } from './store-config.js';
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
import { BuilderCoreError } from './errors.js';
import {
  registerExactCandidate,
  refreshCandidateLanding,
} from './candidate-registry.js';
import {
  verifyExactCandidate,
  invalidateVerification,
  isVerificationAuthoritative,
} from './verifier.js';
import {
  reviewExactCandidate,
  evaluateReviewGate,
  invalidateReview,
  isReviewAuthoritative,
  assertReviewerCannotMutate,
} from './codex-review.js';
import { beginRepairAttempt, resolveRetryPolicy } from './retry.js';
import {
  getAllowedToolManifest,
  invokeTaskTool,
  workerApprovedTools,
  assertToolAllowed,
  resolvePermittedProvider,
  assertResearchCannotMutateAuthority,
} from './tool-policy.js';
import {
  reconcileAfterRestart,
  reconstructAuthoritativeState,
  assertNoDuplicateLaunchAfterRecovery,
} from './recovery.js';
import {
  runOwnerSoftwareTask,
  ORCHESTRATION_DECISION,
} from './orchestrator.js';

export { BuilderCoreError } from './errors.js';

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
  constructor({
    dbPath = ':memory:',
    store,
    workerProvider = null,
    autoRecover = false,
  } = {}) {
    this.trustDomain = TRUST_DOMAIN.BUILDER_CORE;
    this.store = store || openBuilderStore(dbPath);
    this.workerProvider = workerProvider ? assertWorkerProvider(workerProvider) : null;
    // Stage-1: at most one authorized active coding run across the Builder.
    this._currentFactoryRunId = null;
    this._recovery = null;
    if (autoRecover && !this.store.async) {
      // Synchronous pointer restore only; full async reconcile via recover().
      const active = this.store.listActiveRuns();
      if (active.length === 1) this._currentFactoryRunId = active[0].factory_run_id;
      else if (active.length > 1) this._currentFactoryRunId = null;
    }
  }

  close() {
    return this.store.close();
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
    const self = this;
    return co(function* () {
      return yield self.store.getTask(taskId);
    });
  }

  verifyLockedTask(taskId) {
    const self = this;
    return co(function* () {
      const task = yield self.store.getTask(taskId);
      verifyTaskHash(task);
      return task;
    });
  }

  // Status transitions that do not mutate the locked finish line.
  updateTaskStatus(taskId, status) {
    const self = this;
    return co(function* () {
      const task = yield self.store.getTask(taskId);
      if (!task) throw new TaskLockError(`unknown task_id: ${taskId}`);
      if (task.status === TASK_STATUS.DRAFT && status !== TASK_STATUS.LOCKED) {
        throw new TaskLockError('draft task must be locked before other status changes');
      }
      verifyTaskHash(task);
      const updated = yield self.store.updateTask(taskId, { status });
      yield self.store.appendEvent({
        task_id: taskId,
        event_type: EVENT_TYPE.TASK_STATUS_CHANGED,
        payload: { from: task.status, to: status },
      });
      return updated;
    });
  }

  // Reject attempts to rewrite locked acceptance / hash-binding fields.
  attemptMutateLockedTask(taskId, patch) {
    const self = this;
    return co(function* () {
      const task = yield self.store.getTask(taskId);
      assertTaskMutable(task, patch);
      return yield self.store.updateTask(taskId, patch);
    });
  }

  // --- Durable subordinate records (item 4) -------------------------------

  createRun({
    task_id,
    provider,
    provider_run_id = null,
    provider_agent_id = null,
    attempt = null,
  }) {
    const self = this;
    return co(function* () {
      const task = yield self.store.getTask(task_id);
      if (!task) throw new TaskLockError(`unknown task_id: ${task_id}`);
      if (task.status === TASK_STATUS.DRAFT) {
        throw new TaskLockError('cannot create run for unlocked draft task');
      }
      verifyTaskHash(task);
      const existing = yield self.store.listRunsForTask(task_id);
      const nextAttempt = attempt ?? existing.length + 1;
      let run;
      try {
        run = yield self.store.insertRun({
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
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BuilderCoreError(
            `active run already exists for task ${task_id}`,
            'ACTIVE_WORKER_EXISTS'
          );
        }
        throw err;
      }
      yield self.store.appendEvent({
        task_id,
        factory_run_id: run.factory_run_id,
        event_type: EVENT_TYPE.RUN_CREATED,
        payload: { attempt: run.attempt, provider },
      });
      return run;
    });
  }

  getRun(factoryRunId) {
    const self = this;
    return co(function* () {
      return yield self.store.getRun(factoryRunId);
    });
  }

  getCurrentCodingRun() {
    const self = this;
    return co(function* () {
      if (self._currentFactoryRunId) {
        const current = yield self.store.getRun(self._currentFactoryRunId);
        if (current && ACTIVE_RUN_STATUSES.includes(current.status)) return current;
        self._currentFactoryRunId = null;
      }
      const active = yield self.store.listActiveRuns();
      if (active.length > 1) {
        throw new BuilderCoreError(
          `invariant broken: ${active.length} active coding runs`,
          'MULTIPLE_ACTIVE_RUNS'
        );
      }
      if (active[0]) self._currentFactoryRunId = active[0].factory_run_id;
      return active[0] || null;
    });
  }

  assertAuthorizedRun(factoryRunId, { allowTerminalCurrent = false } = {}) {
    const self = this;
    return co(function* () {
      const run = yield self.store.getRun(factoryRunId);
      if (!run) {
        throw new BuilderCoreError(`unknown factory_run_id: ${factoryRunId}`, 'UNKNOWN_RUN');
      }
      const current = yield self.getCurrentCodingRun();
      if (current && current.factory_run_id !== factoryRunId) {
        yield self.store.appendEvent({
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
        if (run.status === RUN_STATUS.STALE) {
          throw new BuilderCoreError(
            `stale run rejected: ${factoryRunId}`,
            'STALE_RUN'
          );
        }
      }
      return run;
    });
  }

  markRunStale(factoryRunId) {
    const self = this;
    return co(function* () {
      const run = yield self.store.getRun(factoryRunId);
      if (!run) throw new BuilderCoreError(`unknown factory_run_id: ${factoryRunId}`);
      const updated = yield self.store.updateRun(factoryRunId, {
        status: RUN_STATUS.STALE,
        ended_at: new Date().toISOString(),
        failure_class: FAILURE_CLASS.STALE_RUN,
      });
      if (self._currentFactoryRunId === factoryRunId) self._currentFactoryRunId = null;
      yield self.store.appendEvent({
        task_id: run.task_id,
        factory_run_id: factoryRunId,
        event_type: EVENT_TYPE.RUN_STATUS_CHANGED,
        payload: { to: RUN_STATUS.STALE },
      });
      return updated;
    });
  }

  // --- WorkerProvider orchestration (items 6–8) ---------------------------

  async launchCodingWorker({ task_id, prompt, envVars = {} }) {
    if (!this.workerProvider) {
      throw new BuilderCoreError('no worker provider configured', 'NO_PROVIDER');
    }
    const existing = await settle(this.getCurrentCodingRun());
    if (existing) {
      throw new BuilderCoreError(
        `only one coding worker may be active; current=${existing.factory_run_id}`,
        'ACTIVE_WORKER_EXISTS'
      );
    }

    const task = await settle(this.verifyLockedTask(task_id));
    const approvedTools = workerApprovedTools(task);
    // Worker receives only the locked task-approved tool surface (default deny).
    if (!approvedTools.providers.includes(this.workerProvider.name)) {
      throw new BuilderCoreError(
        `coding worker provider not permitted by tool_manifest: ${this.workerProvider.name}`,
        'UNAUTHORIZED_TOOL'
      );
    }
    const run = await settle(this.createRun({
      task_id,
      provider: this.workerProvider.name,
    }));
    this._currentFactoryRunId = run.factory_run_id;

    let providerResult;
    try {
      providerResult = normalizeProviderResult(
        await this.workerProvider.launch({
          factory_run_id: run.factory_run_id,
          task,
          prompt,
          envVars,
          allowed_tool_manifest: approvedTools.allowed_tool_manifest,
          approved_tools: approvedTools,
        })
      );
    } catch (err) {
      await settle(this.store.updateRun(run.factory_run_id, {
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
      }));
      this._currentFactoryRunId = null;
      throw err;
    }

    if (providerResult.factory_run_id !== run.factory_run_id) {
      await settle(this.markRunStale(run.factory_run_id));
      throw new BuilderCoreError(
        'provider returned mismatched factory_run_id',
        'FACTORY_RUN_MISMATCH'
      );
    }

    const updated = await settle(this.store.updateRun(run.factory_run_id, {
      provider_run_id: providerResult.provider_run_id,
      provider_agent_id: providerResult.provider_agent_id,
      status: mapProviderStatusToRunStatus(providerResult.provider_status),
      started_at: new Date().toISOString(),
      evidence: providerResult.evidence,
    }));
    await settle(this.updateTaskStatus(task_id, TASK_STATUS.RUNNING));
    await settle(this.store.appendEvent({
      task_id,
      factory_run_id: run.factory_run_id,
      event_type: EVENT_TYPE.WORKER_LAUNCHED,
      payload: {
        provider: providerResult.provider,
        provider_run_id: providerResult.provider_run_id,
        provider_agent_id: providerResult.provider_agent_id,
        provider_status: providerResult.provider_status,
      },
    }));
    return { run: updated, provider_result: providerResult };
  }

  /**
   * Launch provider work onto an existing PENDING factory_run_id (repair path).
   * Does not mint a second run — preserves bounded retry fresh-id semantics.
   */
  async launchCodingWorkerOnRun({ factory_run_id, prompt, envVars = {} }) {
    if (!this.workerProvider) {
      throw new BuilderCoreError('no worker provider configured', 'NO_PROVIDER');
    }
    const run = await settle(this.assertAuthorizedRun(factory_run_id));
    if (run.status !== RUN_STATUS.PENDING) {
      throw new BuilderCoreError(
        `launchCodingWorkerOnRun requires PENDING run, got ${run.status}`,
        'INVALID_RUN_STATUS'
      );
    }
    const claimed = typeof this.store.tryClaimPendingDispatch === 'function'
      ? await settle(this.store.tryClaimPendingDispatch(factory_run_id))
      : run;
    if (!claimed) {
      throw new BuilderCoreError(
        `launch already claimed for ${factory_run_id}`,
        'ALREADY_DISPATCHING'
      );
    }
    const task = await settle(this.verifyLockedTask(run.task_id));
    const approvedTools = workerApprovedTools(task);
    if (!approvedTools.providers.includes(this.workerProvider.name)) {
      throw new BuilderCoreError(
        `coding worker provider not permitted by tool_manifest: ${this.workerProvider.name}`,
        'UNAUTHORIZED_TOOL'
      );
    }
    this._currentFactoryRunId = run.factory_run_id;

    let providerResult;
    try {
      providerResult = normalizeProviderResult(
        await this.workerProvider.launch({
          factory_run_id: run.factory_run_id,
          task,
          prompt,
          envVars,
          allowed_tool_manifest: approvedTools.allowed_tool_manifest,
          approved_tools: approvedTools,
        })
      );
    } catch (err) {
      await settle(this.store.updateRun(run.factory_run_id, {
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
      }));
      this._currentFactoryRunId = null;
      throw err;
    }

    if (providerResult.factory_run_id !== run.factory_run_id) {
      await settle(this.markRunStale(run.factory_run_id));
      throw new BuilderCoreError(
        'provider returned mismatched factory_run_id',
        'FACTORY_RUN_MISMATCH'
      );
    }

    const updated = await settle(this.store.updateRun(run.factory_run_id, {
      provider_run_id: providerResult.provider_run_id,
      provider_agent_id: providerResult.provider_agent_id,
      status: mapProviderStatusToRunStatus(providerResult.provider_status),
      started_at: new Date().toISOString(),
      evidence: providerResult.evidence,
    }));
    await settle(this.updateTaskStatus(run.task_id, TASK_STATUS.RUNNING));
    await settle(this.store.appendEvent({
      task_id: run.task_id,
      factory_run_id: run.factory_run_id,
      event_type: EVENT_TYPE.WORKER_LAUNCHED,
      payload: {
        provider: providerResult.provider,
        provider_run_id: providerResult.provider_run_id,
        provider_agent_id: providerResult.provider_agent_id,
        provider_status: providerResult.provider_status,
        on_existing_run: true,
      },
    }));
    return { run: updated, provider_result: providerResult };
  }

  async runOwnerSoftwareTask(ownerTask, options = {}) {
    return runOwnerSoftwareTask(this, ownerTask, options);
  }

  async refreshWorkerStatus(factoryRunId) {
    if (!this.workerProvider) {
      throw new BuilderCoreError('no worker provider configured', 'NO_PROVIDER');
    }
    const run = await settle(this.assertAuthorizedRun(factoryRunId));
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
    const run = await settle(this.assertAuthorizedRun(factoryRunId));
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
    const applied = await settle(this._applyProviderObservation(
      run,
      providerResult,
      EVENT_TYPE.WORKER_CANCELLED
    ));
    this._currentFactoryRunId = null;
    return applied;
  }

  async collectCodingWorker(factoryRunId, { wait = false } = {}) {
    if (!this.workerProvider) {
      throw new BuilderCoreError('no worker provider configured', 'NO_PROVIDER');
    }
    const run = await settle(this.assertAuthorizedRun(factoryRunId, { allowTerminalCurrent: true }));
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
    const applied = await settle(this._applyProviderObservation(
      run,
      providerResult,
      EVENT_TYPE.WORKER_COLLECTED
    ));
    if (!ACTIVE_RUN_STATUSES.includes(applied.run.status)) {
      this._currentFactoryRunId = null;
    }
    const task = await settle(this.store.getTask(run.task_id));
    return {
      ...applied,
      task_status: task.status,
      task_accepted: false,
    };
  }

  // Reject cancelled/stale provider returns that try to become authoritative later.
  applyProviderResult(factoryRunId, providerResult) {
    const self = this;
    return co(function* () {
      const run = yield self.store.getRun(factoryRunId);
      if (!run) {
        throw new BuilderCoreError(`unknown factory_run_id: ${factoryRunId}`, 'UNKNOWN_RUN');
      }
      if (run.status === RUN_STATUS.STALE || run.status === RUN_STATUS.CANCELLED) {
        yield self.store.appendEvent({
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
      const current = yield self.getCurrentCodingRun();
      if (current && current.factory_run_id !== factoryRunId) {
        yield self.store.appendEvent({
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
      return yield self._applyProviderObservation(
        run,
        normalizeProviderResult(providerResult),
        EVENT_TYPE.WORKER_STATUS
      );
    });
  }

  _applyProviderObservation(run, providerResult, eventType) {
    const self = this;
    if (providerResult.factory_run_id !== run.factory_run_id) {
      throw new BuilderCoreError(
        'provider factory_run_id mismatch',
        'FACTORY_RUN_MISMATCH'
      );
    }

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
    return co(function* () {
      const updated = yield self.store.updateRun(run.factory_run_id, {
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
          self._currentFactoryRunId === run.factory_run_id) {
        self._currentFactoryRunId = null;
      }
      yield self.store.appendEvent({
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
    });
  }

  recordCandidate(input) {
    // Exact GitHub candidate registry (Build Order item 9).
    return registerExactCandidate(this, input);
  }

  async refreshCandidateLanding(candidateId, githubClient) {
    return refreshCandidateLanding(this, candidateId, githubClient);
  }

  async verifyCandidate(candidateId, options = {}) {
    return verifyExactCandidate({
      core: this,
      candidate_id: candidateId,
      ...options,
    });
  }

  invalidateVerification(verificationId, reason) {
    return invalidateVerification(this, verificationId, reason);
  }

  isVerificationAuthoritative(verificationId) {
    return isVerificationAuthoritative(this, verificationId);
  }

  async reviewCandidate(candidateId, options = {}) {
    return reviewExactCandidate({
      core: this,
      candidate_id: candidateId,
      ...options,
    });
  }

  evaluateReviewGate(args) {
    return evaluateReviewGate(args);
  }

  invalidateReview(reviewId, reason) {
    return invalidateReview(this, reviewId, reason);
  }

  isReviewAuthoritative(reviewId) {
    return isReviewAuthoritative(this, reviewId);
  }

  assertReviewerCannotMutate(taskId, patch) {
    return assertReviewerCannotMutate(this, taskId, patch);
  }

  beginRepairAttempt(taskId, options = {}) {
    return beginRepairAttempt(this, taskId, options);
  }

  getRetryPolicy(taskId) {
    const self = this;
    return co(function* () {
      const task = (yield self.getTask(taskId)) || {};
      return resolveRetryPolicy(task);
    });
  }

  // Stage-1 storage for approval records bound to proposal_id + content_hash.
  recordApproval({
    task_id,
    approved_by,
    candidate_id = null,
    commit_sha = null,
    status = 'APPROVED',
  }) {
    const self = this;
    return co(function* () {
      const task = yield self.store.getTask(task_id);
      if (!task) throw new TaskLockError(`unknown task_id: ${task_id}`);
      verifyTaskHash(task);
      if (!task.proposal_id || !task.content_hash) {
        throw new TaskLockError('approval requires locked proposal_id + content_hash');
      }
      if (commit_sha) assertCommitSha(commit_sha);
      const approval = yield self.store.insertApproval({
        approval_id: newApprovalId(),
        task_id,
        proposal_id: task.proposal_id,
        content_hash: task.content_hash,
        candidate_id,
        commit_sha,
        approved_by,
        status,
      });
      yield self.store.appendEvent({
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
    });
  }

  getAllowedToolManifest(taskId) {
    const self = this;
    return co(function* () {
      const task = yield self.verifyLockedTask(taskId);
      return getAllowedToolManifest(task);
    });
  }

  assertToolAllowed(taskId, request) {
    const self = this;
    return co(function* () {
      const task = yield self.verifyLockedTask(taskId);
      return assertToolAllowed(task, request);
    });
  }

  resolvePermittedProvider(taskId, options) {
    const self = this;
    return co(function* () {
      const task = yield self.verifyLockedTask(taskId);
      return resolvePermittedProvider(task, options);
    });
  }

  async invokeTool(input) {
    return invokeTaskTool(this, input);
  }

  async invokeResearch(input) {
    // Research is a tool invocation under the same default-deny policy.
    return invokeTaskTool(this, {
      ...input,
      tool: input.tool || 'research',
    });
  }

  assertResearchCannotMutateAuthority(result) {
    return assertResearchCannotMutateAuthority(result);
  }

  reconstruct() {
    return reconstructAuthoritativeState(this);
  }

  async recover(options = {}) {
    return reconcileAfterRestart(this, options);
  }

  assertNoDuplicateLaunchAfterRecovery() {
    return assertNoDuplicateLaunchAfterRecovery(this);
  }
}

export function createBuilderCore(options) {
  return new BuilderCore(options);
}
