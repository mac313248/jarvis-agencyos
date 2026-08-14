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
  REVIEW_STATUS,
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

export { BuilderStore, openBuilderStore, SCHEMA_VERSION } from './store.js';
export {
  BUILDER_STORE_KIND,
  DEFAULT_SQLITE_PATH,
  BUILDER_PG_SCHEMA,
  BuilderStoreConfigError,
  resolveBuilderStoreConfig,
  isUnattendedBuilderMode,
  blockedStoreDecision,
} from './store-config.js';
export { PostgresBuilderStore, openPostgresBuilderStore } from './store-postgres.js';
export { openBuilderStoreFromConfig, sandboxOwnerId } from './store-open.js';
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
  REDACTED,
  redactSecrets,
  redactString,
  safeJsonStringify,
  safeErrorFields,
  isSensitiveKey,
} from './secrets-redact.js';
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
export {
  reviewExactCandidate,
  evaluateReviewGate,
  invalidateReview,
  isReviewAuthoritative,
  assertReviewerCannotMutate,
  createCodexReviewInvoker,
  buildCodexReviewPrompt,
  parseCodexReviewOutput,
  CodexReviewError,
  isCodexModelCapacityOrUnavailable,
  DEFAULT_CODEX_REVIEW_MODEL,
  DEFAULT_CODEX_FALLBACK_MODEL,
} from './codex-review.js';
export {
  beginRepairAttempt,
  resolveRetryPolicy,
  DEFAULT_RETRY_POLICY,
  NON_RETRYABLE_FAILURE_CLASSES,
  isRetryableFailureClass,
  countAttempts,
  elapsedRuntimeMs,
} from './retry.js';
export {
  ToolPolicyError,
  RESEARCH_FORBIDDEN_AUTHORITY_KEYS,
  getAllowedToolManifest,
  isToolAllowed,
  assertToolAllowed,
  resolvePermittedProvider,
  assertResearchCannotMutateAuthority,
  invokeTaskTool,
  workerApprovedTools,
  assertNoAuthorityPatchFromResearch,
} from './tool-policy.js';
export {
  reconcileAfterRestart,
  reconstructAuthoritativeState,
  assertNoDuplicateLaunchAfterRecovery,
} from './recovery.js';
export {
  runOwnerSoftwareTask,
  extractCandidateLanding,
  resolveLandingSha,
  createDefaultOrchestrationDeps,
  resumeExactCandidateCiAndVerify,
  ORCHESTRATION_DECISION,
  OrchestratorError,
} from './orchestrator.js';
export {
  waitForExactCandidateCi,
  classifyCiSummary,
  detectAwaitingCi,
  CI_WAIT_OUTCOME,
} from './ci-wait.js';
export {
  TICK_TRIGGERS,
  TICK_DECISIONS,
  FORBIDDEN_SCOPES,
  runJarvisTick,
  loadApprovedWorkCatalog,
  stableTaskId,
  isForbiddenScope,
  nextEligibleApprovedWork,
  tickProviderStatus,
  tickProviderCancel,
  tickProviderCollect,
} from './tick.js';
export { acquireTickLock, releaseTickLock, TickLockError } from './tick-lock.js';
export { writeWorkerContract, buildWorkerContractMarkdown } from './worker-contract.js';
