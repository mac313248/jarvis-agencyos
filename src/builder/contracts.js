// src/builder/contracts.js
// Stage-1 Builder Core IDs, enums, and hash helpers.
// Authority: JARVIS_ARCHITECTURE_RECONCILIATION Stage-1 decisions S1-01..S1-16.
// This module is Builder-only. It does not own AgencyOS business authority.

import { createHash, randomUUID } from 'node:crypto';

export const TRUST_DOMAIN = Object.freeze({
  JARVIS_INTERFACE: 'JARVIS_INTERFACE',
  BUILDER_CORE: 'BUILDER_CORE',
  AGENCYOS_BUSINESS_CORE: 'AGENCYOS_BUSINESS_CORE',
});

export const TASK_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  LOCKED: 'LOCKED',
  RUNNING: 'RUNNING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  VERIFIED: 'VERIFIED',
  ACCEPTED: 'ACCEPTED',
  BLOCKED: 'BLOCKED',
  NEEDS_OWNER: 'NEEDS_OWNER',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

export const RUN_STATUS = Object.freeze({
  PENDING: 'PENDING',
  LAUNCHED: 'LAUNCHED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  STALE: 'STALE',
});

export const APPROVAL_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  INVALIDATED: 'INVALIDATED',
  CONSUMED: 'CONSUMED',
});

export const CANDIDATE_STATUS = Object.freeze({
  PROPOSED: 'PROPOSED',
  VERIFYING: 'VERIFYING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  SUPERSEDED: 'SUPERSEDED',
});

export const FAILURE_CLASS = Object.freeze({
  WORKER_CRASH: 'WORKER_CRASH',
  TEST_FAIL: 'TEST_FAIL',
  CI_FAIL: 'CI_FAIL',
  TIMEOUT: 'TIMEOUT',
  COST_CAP: 'COST_CAP',
  ATTEMPT_CAP: 'ATTEMPT_CAP',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  STALE_RUN: 'STALE_RUN',
  ACCEPTANCE_TAMPER: 'ACCEPTANCE_TAMPER',
  POLICY_VIOLATION: 'POLICY_VIOLATION',
  UNKNOWN: 'UNKNOWN',
});

export const EVENT_TYPE = Object.freeze({
  TASK_CREATED: 'TASK_CREATED',
  TASK_LOCKED: 'TASK_LOCKED',
  TASK_STATUS_CHANGED: 'TASK_STATUS_CHANGED',
  RUN_CREATED: 'RUN_CREATED',
  RUN_STATUS_CHANGED: 'RUN_STATUS_CHANGED',
  WORKER_LAUNCHED: 'WORKER_LAUNCHED',
  WORKER_STATUS: 'WORKER_STATUS',
  WORKER_CANCELLED: 'WORKER_CANCELLED',
  WORKER_COLLECTED: 'WORKER_COLLECTED',
  STALE_RUN_REJECTED: 'STALE_RUN_REJECTED',
  CANDIDATE_RECORDED: 'CANDIDATE_RECORDED',
  VERIFICATION_RECORDED: 'VERIFICATION_RECORDED',
  VERIFICATION_INVALIDATED: 'VERIFICATION_INVALIDATED',
  REVIEW_RECORDED: 'REVIEW_RECORDED',
  REVIEW_INVALIDATED: 'REVIEW_INVALIDATED',
  REVIEW_BYPASSED: 'REVIEW_BYPASSED',
  RETRY_STARTED: 'RETRY_STARTED',
  RETRY_DENIED: 'RETRY_DENIED',
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  APPROVAL_RECORDED: 'APPROVAL_RECORDED',
  APPROVAL_INVALIDATED: 'APPROVAL_INVALIDATED',
  TOOL_DENIED: 'TOOL_DENIED',
  RESEARCH_RECORDED: 'RESEARCH_RECORDED',
  RECOVERY_RECONCILED: 'RECOVERY_RECONCILED',
  RECOVERY_BLOCKED: 'RECOVERY_BLOCKED',
  ORCHESTRATION_STARTED: 'ORCHESTRATION_STARTED',
  ORCHESTRATION_DECIDED: 'ORCHESTRATION_DECIDED',
  CI_WAIT_STARTED: 'CI_WAIT_STARTED',
  CI_WAIT_PROGRESS: 'CI_WAIT_PROGRESS',
  CI_WAIT_FINISHED: 'CI_WAIT_FINISHED',
  CI_WAIT_INVALIDATED: 'CI_WAIT_INVALIDATED',
});

export const VERIFICATION_RESULT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
});

export const REVIEW_STATUS = Object.freeze({
  PASS: 'PASS',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
  BLOCKED: 'BLOCKED',
});

export const CI_STATUS = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  UNKNOWN: 'unknown',
});

export const ACTIVE_RUN_STATUSES = Object.freeze([
  RUN_STATUS.PENDING,
  RUN_STATUS.LAUNCHED,
  RUN_STATUS.RUNNING,
]);

const TASK_STATUS_SET = new Set(Object.values(TASK_STATUS));
const RUN_STATUS_SET = new Set(Object.values(RUN_STATUS));
const APPROVAL_STATUS_SET = new Set(Object.values(APPROVAL_STATUS));
const CANDIDATE_STATUS_SET = new Set(Object.values(CANDIDATE_STATUS));
const FAILURE_CLASS_SET = new Set(Object.values(FAILURE_CLASS));
const EVENT_TYPE_SET = new Set(Object.values(EVENT_TYPE));

export function newId(prefix) {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function newTaskId() {
  return newId('task');
}

export function newFactoryRunId() {
  return newId('run');
}

export function newProviderRunId() {
  return newId('prov');
}

export function newCandidateId() {
  return newId('cand');
}

export function newProposalId() {
  return newId('prop');
}

export function newApprovalId() {
  return newId('appr');
}

export function newEventId() {
  return newId('evt');
}

export function assertEnum(name, value, allowed) {
  if (!allowed.has(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return value;
}

export function assertTaskStatus(value) {
  return assertEnum('task status', value, TASK_STATUS_SET);
}

export function assertRunStatus(value) {
  return assertEnum('run status', value, RUN_STATUS_SET);
}

export function assertApprovalStatus(value) {
  return assertEnum('approval status', value, APPROVAL_STATUS_SET);
}

export function assertCandidateStatus(value) {
  return assertEnum('candidate status', value, CANDIDATE_STATUS_SET);
}

export function assertFailureClass(value) {
  return assertEnum('failure class', value, FAILURE_CLASS_SET);
}

export function assertEventType(value) {
  return assertEnum('event type', value, EVENT_TYPE_SET);
}

export function assertSha256Hex(name, value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`invalid ${name}: expected sha256 hex`);
  }
  return value;
}

export function assertCommitSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('invalid commit_sha: expected 40-char lowercase hex');
  }
  return value;
}

export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function sha256Hex(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

export function contentHash(value) {
  return sha256Hex(canonicalJson(value));
}

// Immutable task/proposal binding payload for Stage-1 lock.
// Material change of any field changes the hash and invalidates prior approval.
export function buildTaskLockPayload({
  task_id,
  intent,
  intent_version,
  acceptance_ref,
  allowed_paths,
  tool_manifest,
  review_required,
}) {
  return {
    task_id,
    intent,
    intent_version,
    acceptance_ref,
    allowed_paths: [...allowed_paths].sort(),
    tool_manifest: normalizeToolManifest(tool_manifest),
    review_required: Boolean(review_required),
  };
}

export function normalizeToolManifest(manifest = {}) {
  const providers = Array.isArray(manifest.providers)
    ? [...manifest.providers].map(String).sort()
    : [];
  const tools = Array.isArray(manifest.tools)
    ? [...manifest.tools].map(String).sort()
    : [];
  return {
    providers,
    tools,
    mode: manifest.mode == null ? 'build' : String(manifest.mode),
  };
}

export function taskContentHash(lockPayload) {
  return contentHash(lockPayload);
}
