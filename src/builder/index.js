// Builder Core public surface — software-work authority only.
export {
  TRUST_DOMAIN,
  TASK_STATUS,
  RUN_STATUS,
  APPROVAL_STATUS,
  CANDIDATE_STATUS,
  FAILURE_CLASS,
  EVENT_TYPE,
  newTaskId,
  newFactoryRunId,
  newProviderRunId,
  newCandidateId,
  newProposalId,
  newApprovalId,
  newEventId,
  contentHash,
  taskContentHash,
  buildTaskLockPayload,
  assertTaskStatus,
  assertRunStatus,
  assertApprovalStatus,
  assertCandidateStatus,
  assertFailureClass,
  assertEventType,
  assertSha256Hex,
  assertCommitSha,
} from './contracts.js';

export { BuilderStore, openBuilderStore } from './store.js';
export {
  TaskLockError,
  normalizeOwnerIntent,
  createDraftTask,
  lockTask,
  createAndLockTask,
  assertTaskMutable,
  verifyTaskHash,
} from './task-lock.js';
export { BuilderCore, createBuilderCore } from './core.js';
