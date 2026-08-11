// Builder Core public surface — software-work authority only.
export {
  TRUST_DOMAIN,
  TASK_STATUS,
  RUN_STATUS,
  APPROVAL_STATUS,
  CANDIDATE_STATUS,
  FAILURE_CLASS,
  EVENT_TYPE,
  VERIFICATION_RESULT,
  CI_STATUS,
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
export { BuilderCore, BuilderCoreError, createBuilderCore } from './core.js';
export {
  WorkerProvider,
  WorkerProviderError,
  PROVIDER_STATUS,
  assertWorkerProvider,
  normalizeProviderResult,
} from './worker-provider.js';
export {
  CursorProvider,
  createCursorProvider,
  assertNoBusinessCredentials,
  mapCursorRunStatus,
} from './providers/cursor-provider.js';
export { loadCursorApiKey, CURSOR_KEYCHAIN_SERVICE } from './providers/cursor-api-key.js';
export { createCursorSdkAdapter } from './providers/cursor-sdk-adapter.js';
export {
  createGhLandingClient,
  parseRepoSlug,
  GitHubLandingError,
} from './github-landing.js';
export {
  registerExactCandidate,
  refreshCandidateLanding,
  assertRunCanRegisterCandidate,
} from './candidate-registry.js';
export {
  verifyExactCandidate,
  invalidateVerification,
  isVerificationAuthoritative,
  assertExactShaBinding,
  VerifierError,
} from './verifier.js';
