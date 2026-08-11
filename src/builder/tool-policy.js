// Task-scoped tool / research policy for Builder Stage 1.
// Default deny. Research/tool output is untrusted evidence only and can never
// mutate locked authority (intent, acceptance, paths, credentials, approval,
// retry/budget limits, or DONE).

import {
  EVENT_TYPE,
  FAILURE_CLASS,
  TASK_STATUS,
  normalizeToolManifest,
  newId,
} from './contracts.js';
import { BuilderCoreError } from './errors.js';
import { TaskLockError, verifyTaskHash } from './task-lock.js';

export class ToolPolicyError extends Error {
  constructor(message, code = 'TOOL_POLICY_VIOLATION') {
    super(message);
    this.name = 'ToolPolicyError';
    this.code = code;
  }
}

/** Authority fields that research/tool output may never change. */
export const RESEARCH_FORBIDDEN_AUTHORITY_KEYS = Object.freeze([
  'intent',
  'intent_version',
  'acceptance_ref',
  'allowed_paths',
  'tool_manifest',
  'allowed_tool_manifest',
  'credentials',
  'api_key',
  'secret',
  'approval',
  'approval_status',
  'grant_approval',
  'max_attempts',
  'max_runtime_ms',
  'cost_budget_status',
  'status',
  'mark_done',
  'done',
  'task_status',
  'proposal_id',
  'content_hash',
  'review_required',
]);

function nowIso() {
  return new Date().toISOString();
}

export function getAllowedToolManifest(task) {
  if (!task) throw new ToolPolicyError('unknown task', 'UNKNOWN_TASK');
  return Object.freeze(normalizeToolManifest(task.tool_manifest || {}));
}

export function isToolAllowed(task, { provider = null, tool = null } = {}) {
  const manifest = getAllowedToolManifest(task);
  if (provider != null && !manifest.providers.includes(String(provider))) {
    return false;
  }
  if (tool != null && !manifest.tools.includes(String(tool))) {
    return false;
  }
  // Default deny: requesting neither provider nor tool is not a grant.
  if (provider == null && tool == null) return false;
  return true;
}

export function assertToolAllowed(task, request = {}) {
  if (!isToolAllowed(task, request)) {
    throw new ToolPolicyError(
      `unauthorized tool request denied (default deny): provider=${request.provider ?? '-'} tool=${request.tool ?? '-'}`,
      'UNAUTHORIZED_TOOL'
    );
  }
  return getAllowedToolManifest(task);
}

/**
 * Resolve a permitted provider. Unavailable requested provider may fall back
 * only when exactly one other already-permitted provider is available.
 * Never widens the manifest.
 */
export function resolvePermittedProvider(task, {
  provider,
  availability = {},
} = {}) {
  const manifest = getAllowedToolManifest(task);
  const requested = provider == null ? null : String(provider);
  if (!requested || !manifest.providers.includes(requested)) {
    throw new ToolPolicyError(
      `provider not permitted by task tool_manifest: ${requested}`,
      'UNAUTHORIZED_TOOL'
    );
  }
  if (availability[requested] !== false) {
    return {
      provider: requested,
      fallback: false,
      unavailable: false,
    };
  }
  const alternates = manifest.providers.filter(
    (p) => p !== requested && availability[p] !== false
  );
  if (alternates.length === 1) {
    return {
      provider: alternates[0],
      fallback: true,
      unavailable: true,
      requested,
    };
  }
  if (alternates.length === 0) {
    throw new ToolPolicyError(
      `permitted provider unavailable and no permitted fallback: ${requested}`,
      'PROVIDER_UNAVAILABLE'
    );
  }
  throw new ToolPolicyError(
    `permitted provider unavailable; multiple permitted fallbacks are ambiguous: ${requested}`,
    'PROVIDER_FALLBACK_AMBIGUOUS'
  );
}

function collectForbiddenAuthorityKeys(value, found = new Set(), depth = 0) {
  if (value == null || depth > 6) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenAuthorityKeys(item, found, depth + 1);
    return found;
  }
  if (typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (RESEARCH_FORBIDDEN_AUTHORITY_KEYS.includes(key)) found.add(key);
    collectForbiddenAuthorityKeys(child, found, depth + 1);
  }
  return found;
}

export function assertResearchCannotMutateAuthority(result) {
  const forbidden = [...collectForbiddenAuthorityKeys(result)];
  if (forbidden.length) {
    throw new ToolPolicyError(
      `research/tool output attempted forbidden authority mutation: ${forbidden.join(',')}`,
      'RESEARCH_AUTHORITY_VIOLATION'
    );
  }
  return true;
}

/**
 * Invoke a task-scoped tool under default-deny policy.
 * Records provenance. Research/tool output is untrusted evidence only.
 */
export async function invokeTaskTool(core, {
  task_id,
  provider,
  tool,
  args = {},
  availability = {},
  invoke,
}) {
  const task = core.store.getTask(task_id);
  if (!task) throw new ToolPolicyError(`unknown task_id: ${task_id}`, 'UNKNOWN_TASK');
  verifyTaskHash(task);

  let resolved;
  try {
    assertToolAllowed(task, { provider, tool });
    resolved = resolvePermittedProvider(task, { provider, availability });
  } catch (err) {
    const code = err.code || 'TOOL_POLICY_VIOLATION';
    core.store.appendEvent({
      task_id,
      event_type: EVENT_TYPE.TOOL_DENIED,
      payload: {
        provider,
        tool,
        code,
        message: err.message,
        failure_class: FAILURE_CLASS.POLICY_VIOLATION,
      },
    });
    if (
      code === 'UNAUTHORIZED_TOOL' ||
      code === 'PROVIDER_UNAVAILABLE' ||
      code === 'PROVIDER_FALLBACK_AMBIGUOUS' ||
      code === 'RESEARCH_AUTHORITY_VIOLATION'
    ) {
      if (task.status !== TASK_STATUS.BLOCKED && task.status !== TASK_STATUS.FAILED) {
        core.updateTaskStatus(task_id, TASK_STATUS.BLOCKED);
      }
    }
    throw err;
  }

  if (typeof invoke !== 'function') {
    throw new ToolPolicyError('tool invoke function required', 'INVOKE_MISSING');
  }

  const started_at = nowIso();
  let raw;
  try {
    raw = await invoke({
      provider: resolved.provider,
      tool,
      args,
      task,
      allowed_tool_manifest: getAllowedToolManifest(task),
      fallback: resolved.fallback,
    });
  } catch (err) {
    core.store.appendEvent({
      task_id,
      event_type: EVENT_TYPE.TOOL_DENIED,
      payload: {
        provider: resolved.provider,
        tool,
        code: err.code || 'TOOL_INVOKE_FAILED',
        message: String(err.message || err),
        failure_class: FAILURE_CLASS.PROVIDER_ERROR,
      },
    });
    throw err;
  }

  try {
    assertResearchCannotMutateAuthority(raw);
  } catch (err) {
    core.store.appendEvent({
      task_id,
      event_type: EVENT_TYPE.TOOL_DENIED,
      payload: {
        provider: resolved.provider,
        tool,
        code: err.code,
        message: err.message,
        failure_class: FAILURE_CLASS.POLICY_VIOLATION,
      },
    });
    if (task.status !== TASK_STATUS.BLOCKED) {
      core.updateTaskStatus(task_id, TASK_STATUS.BLOCKED);
    }
    throw err;
  }

  const evidence_id = newId('trev');
  const evidence = {
    evidence_id,
    task_id,
    provider: resolved.provider,
    requested_provider: provider,
    tool,
    untrusted: true,
    authoritative: false,
    fallback: Boolean(resolved.fallback),
    args_digest: JSON.stringify(args ?? {}),
    result: raw,
    captured_at: nowIso(),
    started_at,
  };

  core.store.appendEvent({
    task_id,
    event_type: EVENT_TYPE.RESEARCH_RECORDED,
    evidence_ref: evidence_id,
    payload: evidence,
  });

  // Worker/tool path cannot mark DONE or mutate locked finish-line fields.
  const after = core.store.getTask(task_id);
  verifyTaskHash(after);
  if (after.status === TASK_STATUS.ACCEPTED) {
    throw new BuilderCoreError(
      'tool/research path cannot mark task DONE/ACCEPTED',
      'AUTHORITY_VIOLATION'
    );
  }

  return {
    ok: true,
    evidence,
    allowed_tool_manifest: getAllowedToolManifest(after),
  };
}

/** Snapshot of tools a worker may receive — never more than the locked manifest. */
export function workerApprovedTools(task) {
  const manifest = getAllowedToolManifest(task);
  return {
    allowed_tool_manifest: manifest,
    providers: [...manifest.providers],
    tools: [...manifest.tools],
    mode: manifest.mode,
  };
}

export function assertNoAuthorityPatchFromResearch(taskId, patch) {
  if (!patch || typeof patch !== 'object') return true;
  for (const key of Object.keys(patch)) {
    if (RESEARCH_FORBIDDEN_AUTHORITY_KEYS.includes(key)) {
      throw new TaskLockError(
        `research/tool cannot mutate authority field '${key}' on task ${taskId}`
      );
    }
  }
  return true;
}
