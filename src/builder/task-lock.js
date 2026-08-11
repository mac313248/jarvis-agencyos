// src/builder/task-lock.js
// Stage-1 task-lock path:
//   owner intent → normalized task → allowed paths/tools → acceptance ref
//   → immutable task/proposal hash
//
// Once LOCKED, acceptance / paths / tools / intent cannot be mutated.
// A material change requires a new intent_version / new proposal hash.

import {
  TASK_STATUS,
  EVENT_TYPE,
  buildTaskLockPayload,
  newProposalId,
  newTaskId,
  normalizeToolManifest,
  taskContentHash,
} from './contracts.js';

export class TaskLockError extends Error {
  constructor(reason) {
    super(`task lock error: ${reason}`);
    this.name = 'TaskLockError';
    this.reason = reason;
  }
}

function normalizeAllowedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new TaskLockError('allowed_paths must be a non-empty array');
  }
  const normalized = [...new Set(paths.map((p) => String(p).trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new TaskLockError('allowed_paths must contain at least one path');
  }
  return normalized.sort();
}

function requireNonEmptyString(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskLockError(`${name} is required`);
  }
  return value.trim();
}

export function normalizeOwnerIntent(input) {
  if (!input || typeof input !== 'object') {
    throw new TaskLockError('intent payload is required');
  }
  const intent = requireNonEmptyString('intent', input.intent);
  const acceptance_ref = requireNonEmptyString('acceptance_ref', input.acceptance_ref);
  const allowed_paths = normalizeAllowedPaths(input.allowed_paths);
  const tool_manifest = normalizeToolManifest(input.tool_manifest || {});
  const review_required =
    input.review_required === undefined ? true : Boolean(input.review_required);
  const priority =
    input.priority == null ? 100 : Number.parseInt(input.priority, 10);
  if (!Number.isFinite(priority)) {
    throw new TaskLockError('priority must be a number');
  }
  return {
    intent,
    acceptance_ref,
    allowed_paths,
    tool_manifest,
    review_required,
    priority,
    intent_version: 1,
  };
}

export function createDraftTask(store, ownerIntent) {
  const normalized = normalizeOwnerIntent(ownerIntent);
  const task = store.insertTask({
    task_id: ownerIntent.task_id || newTaskId(),
    intent: normalized.intent,
    intent_version: normalized.intent_version,
    acceptance_ref: normalized.acceptance_ref,
    allowed_paths: normalized.allowed_paths,
    tool_manifest: normalized.tool_manifest,
    review_required: normalized.review_required,
    priority: normalized.priority,
    status: TASK_STATUS.DRAFT,
  });
  store.appendEvent({
    task_id: task.task_id,
    event_type: EVENT_TYPE.TASK_CREATED,
    payload: {
      status: task.status,
      acceptance_ref: task.acceptance_ref,
      allowed_paths: task.allowed_paths,
    },
  });
  return task;
}

export function lockTask(store, taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new TaskLockError(`unknown task_id: ${taskId}`);
  if (task.status === TASK_STATUS.LOCKED) {
    return task;
  }
  if (task.status !== TASK_STATUS.DRAFT) {
    throw new TaskLockError(
      `cannot lock task in status ${task.status}; expected DRAFT`
    );
  }

  const proposal_id = newProposalId();
  const lockPayload = buildTaskLockPayload({
    task_id: task.task_id,
    intent: task.intent,
    intent_version: task.intent_version,
    acceptance_ref: task.acceptance_ref,
    allowed_paths: task.allowed_paths,
    tool_manifest: task.tool_manifest,
    review_required: task.review_required,
  });
  const content_hash = taskContentHash(lockPayload);
  const locked_at = new Date().toISOString();

  const locked = store.updateTask(taskId, {
    status: TASK_STATUS.LOCKED,
    proposal_id,
    content_hash,
    locked_at,
  });

  store.appendEvent({
    task_id: locked.task_id,
    event_type: EVENT_TYPE.TASK_LOCKED,
    payload: {
      proposal_id,
      content_hash,
      acceptance_ref: locked.acceptance_ref,
      lock_payload: lockPayload,
    },
  });

  return locked;
}

// Fail closed: locked task fields that define the finish line are immutable.
const IMMUTABLE_WHEN_LOCKED = new Set([
  'intent',
  'intent_version',
  'acceptance_ref',
  'allowed_paths',
  'tool_manifest',
  'review_required',
  'proposal_id',
  'content_hash',
]);

export function assertTaskMutable(task, patch) {
  if (!task) throw new TaskLockError('unknown task');
  if (task.status === TASK_STATUS.DRAFT) return;
  if (task.status !== TASK_STATUS.LOCKED && !isPostLockStatus(task.status)) {
    return;
  }
  for (const key of Object.keys(patch || {})) {
    if (!IMMUTABLE_WHEN_LOCKED.has(key)) continue;
    const before = normalizeComparable(key, task[key]);
    const after = normalizeComparable(key, patch[key]);
    if (before !== after) {
      throw new TaskLockError(
        `immutable field '${key}' cannot change after lock (acceptance/hash binding)`
      );
    }
  }
}

function isPostLockStatus(status) {
  return [
    TASK_STATUS.LOCKED,
    TASK_STATUS.RUNNING,
    TASK_STATUS.AWAITING_APPROVAL,
    TASK_STATUS.VERIFIED,
    TASK_STATUS.ACCEPTED,
    TASK_STATUS.BLOCKED,
    TASK_STATUS.NEEDS_OWNER,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
  ].includes(status);
}

function normalizeComparable(key, value) {
  if (key === 'allowed_paths' || key === 'tool_manifest') {
    return JSON.stringify(value ?? null);
  }
  if (key === 'review_required') return Boolean(value);
  return value;
}

export function verifyTaskHash(task) {
  if (!task?.content_hash || !task?.proposal_id) {
    throw new TaskLockError('task is not locked with proposal/content hash');
  }
  const expected = taskContentHash(
    buildTaskLockPayload({
      task_id: task.task_id,
      intent: task.intent,
      intent_version: task.intent_version,
      acceptance_ref: task.acceptance_ref,
      allowed_paths: task.allowed_paths,
      tool_manifest: task.tool_manifest,
      review_required: task.review_required,
    })
  );
  if (expected !== task.content_hash) {
    throw new TaskLockError('content_hash mismatch; locked finish line was altered');
  }
  return true;
}

export function createAndLockTask(store, ownerIntent) {
  const draft = createDraftTask(store, ownerIntent);
  return lockTask(store, draft.task_id);
}
