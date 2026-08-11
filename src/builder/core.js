// src/builder/core.js
// Builder Core — trusted software-work authority (Stage 1).
// Owns durable task/run/candidate/approval/event state and task locking.
// Does NOT own AgencyOS tenant/business authority or production credentials.

import {
  CANDIDATE_STATUS,
  EVENT_TYPE,
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

export class BuilderCore {
  constructor({ dbPath = ':memory:', store } = {}) {
    this.trustDomain = TRUST_DOMAIN.BUILDER_CORE;
    this.store = store || openBuilderStore(dbPath);
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

  createRun({ task_id, provider, provider_run_id = null, attempt = null }) {
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
      attempt: nextAttempt,
      status: RUN_STATUS.PENDING,
      started_at: null,
      ended_at: null,
      failure_class: null,
    });
    this.store.appendEvent({
      task_id,
      factory_run_id: run.factory_run_id,
      event_type: EVENT_TYPE.RUN_CREATED,
      payload: { attempt: run.attempt, provider },
    });
    return run;
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
