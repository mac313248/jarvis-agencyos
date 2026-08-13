// Deterministic jarvis:tick control-plane dispatcher.
// Selects exactly one logical objective per trigger and claims it through
// existing Builder Core task/run authority. Does not create a second queue.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANDIDATE_STATUS,
  EVENT_TYPE,
  FAILURE_CLASS,
  REVIEW_STATUS,
  RUN_STATUS,
  TASK_STATUS,
  newFactoryRunId,
} from './contracts.js';
import { beginRepairAttempt } from './retry.js';
import { invalidateVerification } from './verifier.js';
import { invalidateReview } from './codex-review.js';
import { acquireTickLock, TickLockError } from './tick-lock.js';
import { writeWorkerContract } from './worker-contract.js';
import { assertNoBusinessCredentials } from './providers/cursor-provider.js';
import { redactSecrets } from './secrets-redact.js';
import { FOUNDATION_SLICES } from '../../scripts/build-runner.mjs';
import { LIVE_VERIFICATION_ITEMS, runOrientation } from '../../scripts/orientation.mjs';
import { settle } from './thenable.js';
import {
  blockedStoreDecision,
  BUILDER_STORE_KIND,
} from './store-config.js';
import { sandboxOwnerId } from './store-open.js';

export const TICK_TRIGGERS = Object.freeze([
  'hourly',
  'checks_failed',
  'changes_requested',
  'manual_smoke',
]);

export const TICK_DECISIONS = Object.freeze({
  EXECUTE: 'EXECUTE',
  REPAIR: 'REPAIR',
  NOOP: 'NOOP',
  NEEDS_OWNER: 'NEEDS_OWNER',
  BLOCKED: 'BLOCKED',
});

export const FORBIDDEN_SCOPES = Object.freeze([
  'hermes',
  'voice',
  'obsidian',
  'prime',
  'extra_coding_workers',
  'new_product_scope',
]);

const OPEN_TASK_STATUSES = new Set([
  TASK_STATUS.LOCKED,
  TASK_STATUS.RUNNING,
  TASK_STATUS.FAILED,
]);

const STOP_TASK_STATUSES = new Set([
  TASK_STATUS.NEEDS_OWNER,
  TASK_STATUS.BLOCKED,
  TASK_STATUS.ACCEPTED,
  TASK_STATUS.CANCELLED,
]);

function assertTrigger(trigger) {
  switch (trigger) {
    case 'hourly':
    case 'checks_failed':
    case 'changes_requested':
    case 'manual_smoke':
      return trigger;
    default: {
      const _exhaustive = trigger;
      throw new Error(`unsupported jarvis:tick trigger: ${String(_exhaustive)}`);
    }
  }
}

export function loadApprovedWorkCatalog(root) {
  const raw = JSON.parse(readFileSync(join(root, 'control/prd.json'), 'utf8'));
  if (raw.durable_state && /second queue/i.test(String(raw.note || ''))) {
    // Catalog-only file; Builder Core remains the task store.
  }
  return raw;
}

export function stableTaskId(workId) {
  return 'task_' + String(workId).replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function isForbiddenScope(value) {
  const hay = String(value || '').toLowerCase();
  return FORBIDDEN_SCOPES.some((scope) => hay.includes(scope));
}

function openLiveItems() {
  return LIVE_VERIFICATION_ITEMS.filter((item) => item.live_status === 'OPEN');
}

export function nextEligibleApprovedWork(orientation, catalog = {}) {
  const forbidden = new Set([
    ...FORBIDDEN_SCOPES,
    ...(catalog.forbidden_scopes || []),
  ].map((s) => String(s).toLowerCase()));
  const future = new Set((catalog.future_phases || ['V1.1']).map((s) => String(s)));

  if (orientation?.implementation_slices?.next?.phase_id) {
    const slice = FOUNDATION_SLICES.find(
      (s) => s.phase_id === orientation.implementation_slices.next.phase_id
    );
    if (slice && !forbidden.has(slice.phase_id.toLowerCase()) && !future.has(slice.phase_id)) {
      return {
        work_id: slice.phase_id,
        kind: 'implementation_slice',
        title: slice.phase_name,
        acceptance_ref: slice.sot_references[0],
        allowed_paths: [slice.evidence_marker, 'scripts/', 'tests/'],
        owner_gate: false,
        future_phase: false,
      };
    }
  }

  const completed = new Set(orientation?.completed_deterministic_gates || []);
  for (const item of openLiveItems()) {
    if (item.owner_gate) continue;
    if (isForbiddenScope(item.id) || isForbiddenScope(item.title)) continue;
    if (forbidden.has(String(item.id).toLowerCase())) continue;
    const ready = (item.ready_after || []).every((req) => completed.has(req));
    if (!ready) continue;
    return {
      work_id: item.id,
      kind: 'live_verification',
      title: item.title,
      acceptance_ref: item.sot_ref,
      allowed_paths: ['src/', 'tests/', 'scripts/'],
      owner_gate: false,
      future_phase: false,
    };
  }
  return null;
}

function ownerNeed(orientation) {
  const t2 = (orientation?.owner_blockers || []).find((b) => /T2/i.test(b));
  if (t2 || orientation?.next_phase_candidate === 'V1.1') {
    return {
      decision: TICK_DECISIONS.NEEDS_OWNER,
      reason: 'FIRST_BOUNDED_T2_NOT_SELECTED',
      owner_action: 'Select the approved first bounded T2 routine.',
    };
  }
  const first = orientation?.owner_blockers?.[0] || orientation?.claim_task?.reason;
  return {
    decision: TICK_DECISIONS.NEEDS_OWNER,
    reason: 'OWNER_GATE',
    owner_action: first || 'Owner authority is required before further work.',
  };
}

function decisionFields(partial, orientation, trigger) {
  return redactSecrets({
    decision: partial.decision,
    trigger,
    task_id: partial.task_id || null,
    factory_run_id: partial.factory_run_id || null,
    provider_run_id: partial.provider_run_id || null,
    provider: partial.provider || null,
    worker_contract: partial.worker_contract || null,
    pr: partial.pr || null,
    head_sha: partial.head_sha || orientation?.head_sha || null,
    reason: partial.reason,
    owner_action: partial.owner_action || null,
    logical_work_id: partial.logical_work_id || null,
    dispatched: Boolean(partial.dispatched),
  });
}

async function openTasks(core) {
  const tasks = await settle(core.store.listTasks());
  return tasks.filter((t) => OPEN_TASK_STATUSES.has(t.status));
}

async function candidateIsAuthoritative(core, candidate) {
  if (!candidate) return false;
  if (candidate.status === CANDIDATE_STATUS.SUPERSEDED) return false;
  if (candidate.status === CANDIDATE_STATUS.REJECTED) return false;
  const run = await settle(core.store.getRun(candidate.factory_run_id));
  if (!run) return false;
  if (run.status === RUN_STATUS.STALE || run.status === RUN_STATUS.CANCELLED) return false;
  return true;
}

async function candidateHasFailedCi(core, candidate) {
  if (!(await candidateIsAuthoritative(core, candidate))) return false;
  const conclusion = String(candidate?.ci_conclusion || '').toLowerCase();
  return ['failure', 'timed_out', 'action_required', 'cancelled'].includes(conclusion);
}

async function findFailedCiWork(core) {
  for (const task of await openTasks(core)) {
    const candidates = await settle(core.store.listCandidatesForTask(task.task_id));
    for (const candidate of [...candidates].reverse()) {
      if (await candidateHasFailedCi(core, candidate)) {
        return { task, candidate, reason: 'CI_FAILED', pr: candidate.pr_number || null };
      }
    }
  }
  return null;
}

async function findChangesRequestedWork(core, githubReviews = []) {
  for (const review of githubReviews) {
    if (!review?.task_id) continue;
    const task = await settle(core.getTask(review.task_id));
    if (task && OPEN_TASK_STATUSES.has(task.status)) {
      return {
        task,
        reason: 'CHANGES_REQUESTED',
        pr: review.pr || review.pr_number || null,
      };
    }
  }
  for (const task of await openTasks(core)) {
    const candidates = await settle(core.store.listCandidatesForTask(task.task_id));
    for (const candidate of candidates) {
      const reviews = await settle(core.store.listReviewsForCandidate(candidate.candidate_id));
      const requested = reviews.find((r) =>
        r.status === REVIEW_STATUS.REQUEST_CHANGES && !r.invalidated_at
      );
      if (requested && await candidateIsAuthoritative(core, candidate)) {
        return {
          task,
          candidate,
          reason: 'CHANGES_REQUESTED',
          pr: candidate.pr_number || null,
        };
      }
    }
  }
  return null;
}

async function latestRun(core, taskId) {
  const runs = await settle(core.store.listRunsForTask(taskId));
  return runs.length ? runs[runs.length - 1] : null;
}

async function taskHasAuthoritativeFailedCi(core, taskId) {
  const candidates = await settle(core.store.listCandidatesForTask(taskId));
  for (const candidate of candidates) {
    if (await candidateHasFailedCi(core, candidate)) return true;
  }
  return false;
}

async function findAwaitingHandoff(core) {
  const tasks = await settle(core.store.listTasks());
  for (const task of tasks) {
    if (STOP_TASK_STATUSES.has(task.status)) continue;
    const run = await latestRun(core, task.task_id);
    if (!run) continue;
    if (run.status === RUN_STATUS.SUCCEEDED && !(await taskHasAuthoritativeFailedCi(core, task.task_id))) {
      return {
        decision: TICK_DECISIONS.NOOP,
        reason: 'AWAITING_VERIFY_HANDOFF',
        task_id: task.task_id,
        factory_run_id: run.factory_run_id,
      };
    }
  }
  return null;
}

async function findContinuation(core) {
  const tasks = await openTasks(core);
  const failed = tasks.find((t) => t.status === TASK_STATUS.FAILED);
  if (failed) return { task: failed, repair: true, reason: 'CLAIMED_TASK_CONTINUATION' };
  for (const running of tasks) {
    if (running.status !== TASK_STATUS.RUNNING && running.status !== TASK_STATUS.LOCKED) continue;
    const run = await latestRun(core, running.task_id);
    if (run?.status === RUN_STATUS.SUCCEEDED) continue;
    const needsRepair = run && [
      RUN_STATUS.FAILED,
      RUN_STATUS.CANCELLED,
      RUN_STATUS.STALE,
    ].includes(run.status);
    return {
      task: running,
      repair: Boolean(needsRepair),
      reason: 'CLAIMED_TASK_CONTINUATION',
    };
  }
  return null;
}

async function invalidateTaskEvidence(core, taskId, reason) {
  const candidates = await settle(core.store.listCandidatesForTask(taskId));
  for (const candidate of candidates) {
    if (candidate.status !== CANDIDATE_STATUS.SUPERSEDED) {
      await settle(core.store.updateCandidate(candidate.candidate_id, {
        status: CANDIDATE_STATUS.SUPERSEDED,
      }));
    }
    const verifications = await settle(
      core.store.listVerificationsForCandidate(candidate.candidate_id)
    );
    for (const verification of verifications) {
      if (!verification.invalidated_at) {
        await settle(invalidateVerification(core, verification.verification_id, reason));
      }
    }
    const reviews = await settle(core.store.listReviewsForCandidate(candidate.candidate_id));
    for (const review of reviews) {
      if (!review.invalidated_at) {
        await settle(invalidateReview(core, review.review_id, reason));
      }
    }
  }
}

async function claimOrReuse(core, work) {
  const taskId = stableTaskId(work.work_id);
  if (typeof core.store.claimLogicalWork === 'function') {
    const claimed = await settle(core.store.claimLogicalWork({
      task_id: taskId,
      logical_work_id: work.work_id,
      intent: work.title,
      acceptance_ref: work.acceptance_ref,
      allowed_paths: work.allowed_paths,
      tool_manifest: {
        providers: ['cursor'],
        tools: ['coding_worker', 'repo_read'],
        mode: 'build',
      },
      review_required: true,
    }));
    const existing = claimed.task;
    if (existing?.status === TASK_STATUS.NEEDS_OWNER) {
      return { stop: TICK_DECISIONS.NEEDS_OWNER, task: existing, reason: 'TASK_NEEDS_OWNER' };
    }
    if (existing?.status === TASK_STATUS.BLOCKED) {
      return { stop: TICK_DECISIONS.BLOCKED, task: existing, reason: 'TASK_BLOCKED' };
    }
    if (existing?.status === TASK_STATUS.ACCEPTED || existing?.status === TASK_STATUS.CANCELLED) {
      return null;
    }
    return { task: existing, already_claimed: Boolean(claimed.already_claimed) };
  }
  const existing = await settle(core.getTask(taskId));
  if (existing) {
    if (existing.status === TASK_STATUS.NEEDS_OWNER) {
      return { stop: TICK_DECISIONS.NEEDS_OWNER, task: existing, reason: 'TASK_NEEDS_OWNER' };
    }
    if (existing.status === TASK_STATUS.BLOCKED) {
      return { stop: TICK_DECISIONS.BLOCKED, task: existing, reason: 'TASK_BLOCKED' };
    }
    if (existing.status === TASK_STATUS.ACCEPTED || existing.status === TASK_STATUS.CANCELLED) {
      return null;
    }
    return { task: existing, already_claimed: true };
  }
  const created = await settle(core.createAndLockTask({
    task_id: taskId,
    logical_work_id: work.work_id,
    intent: work.title,
    acceptance_ref: work.acceptance_ref,
    allowed_paths: work.allowed_paths,
    tool_manifest: {
      providers: ['cursor'],
      tools: ['coding_worker', 'repo_read'],
      mode: 'build',
    },
    review_required: true,
  }));
  return { task: created, already_claimed: false };
}

function persistTickDecision(root, decision) {
  const dir = join(root, '.data/builder');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last-tick.json'), JSON.stringify(decision, null, 2) + '\n');
  if (decision.factory_run_id) {
    const runDir = join(root, 'control/runs', decision.factory_run_id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'decision.json'), JSON.stringify(decision, null, 2) + '\n');
  }
}

async function selectOne({ core, orientation, catalog, githubReviews, recovery, owner }) {
  if (recovery?.status === 'BLOCKED') {
    return {
      decision: TICK_DECISIONS.BLOCKED,
      reason: recovery.reason || 'UNSAFE_AUTHORITATIVE_STATE',
    };
  }

  let current = null;
  try {
    current = await settle(core.getCurrentCodingRun());
  } catch (err) {
    return {
      decision: TICK_DECISIONS.BLOCKED,
      reason: err.code || 'UNSAFE_AUTHORITATIVE_STATE',
    };
  }

  if (current && [RUN_STATUS.PENDING, RUN_STATUS.LAUNCHED, RUN_STATUS.RUNNING].includes(current.status)) {
    const lease = typeof core.store.getControlLease === 'function'
      ? await settle(core.store.getControlLease('active_coding_run'))
      : null;
    if (lease && lease.owner && lease.owner !== owner && !current.provider_run_id) {
      return {
        decision: TICK_DECISIONS.NOOP,
        reason: 'WORKER_IN_FLIGHT',
        task_id: current.task_id,
        factory_run_id: current.factory_run_id,
        provider_run_id: current.provider_run_id || null,
        head_sha: orientation.head_sha,
      };
    }
    if (!current.provider_run_id && (!lease || lease.owner === owner)) {
      return {
        decision: TICK_DECISIONS.EXECUTE,
        task: await settle(core.getTask(current.task_id)),
        reason: 'CLAIMED_TASK_CONTINUATION',
        factory_run_id: current.factory_run_id,
      };
    }
    return {
      decision: TICK_DECISIONS.NOOP,
      reason: 'WORKER_IN_FLIGHT',
      task_id: current.task_id,
      factory_run_id: current.factory_run_id,
      provider_run_id: current.provider_run_id || null,
      head_sha: orientation.head_sha,
    };
  }

  const ciFailed = await findFailedCiWork(core);
  if (ciFailed) {
    return {
      decision: TICK_DECISIONS.REPAIR,
      task: ciFailed.task,
      pr: ciFailed.pr,
      reason: 'CI_FAILED',
    };
  }

  const changes = await findChangesRequestedWork(core, githubReviews);
  if (changes) {
    return {
      decision: TICK_DECISIONS.REPAIR,
      task: changes.task,
      pr: changes.pr,
      reason: 'CHANGES_REQUESTED',
    };
  }

  const handoff = await findAwaitingHandoff(core);
  if (handoff) return handoff;

  const continuation = await findContinuation(core);
  if (continuation) {
    return {
      decision: continuation.repair ? TICK_DECISIONS.REPAIR : TICK_DECISIONS.EXECUTE,
      task: continuation.task,
      reason: continuation.reason,
    };
  }

  const work = nextEligibleApprovedWork(orientation, catalog);
  if (work) {
    if (work.future_phase || work.owner_gate) return ownerNeed(orientation);
    return {
      decision: TICK_DECISIONS.EXECUTE,
      work,
      reason: 'NEXT_DEPENDENCY_READY_TASK',
    };
  }

  if (
    orientation?.claim_task?.via === 'WAITING_ON_OWNER' ||
    (orientation?.owner_blockers || []).length > 0
  ) {
    return ownerNeed(orientation);
  }

  return { decision: TICK_DECISIONS.NOOP, reason: 'NO_ELIGIBLE_WORK' };
}

async function maybeDispatch({
  core,
  task,
  factoryRunId,
  dispatch,
  prompt,
}) {
  if (!dispatch || !core.workerProvider) {
    return { dispatched: false, provider_run_id: null, provider: null };
  }
  const launched = factoryRunId
    ? await core.launchCodingWorkerOnRun({
        factory_run_id: factoryRunId,
        prompt,
      })
    : await core.launchCodingWorker({
        task_id: task.task_id,
        prompt,
      });
  return {
    dispatched: true,
    provider_run_id: launched.run?.provider_run_id || launched.provider_run_id || null,
    provider: launched.run?.provider || core.workerProvider.name,
    factory_run_id: launched.run?.factory_run_id || launched.factory_run_id || factoryRunId,
    provider_agent_id: launched.run?.provider_agent_id || null,
  };
}

function buildPrompt(task, contractPath) {
  return [
    'Execute the bounded worker contract. Do not set PASS/DONE. Do not advance phases.',
    `task_id: ${task.task_id}`,
    `worker_contract: ${contractPath}`,
    `intent: ${task.intent}`,
    `acceptance_ref: ${task.acceptance_ref}`,
    `allowed_paths: ${JSON.stringify(task.allowed_paths)}`,
  ].join('\n');
}

export async function runJarvisTick({
  root,
  trigger,
  core,
  dispatch = false,
  orientation: providedOrientation = null,
  runOrientationFn = runOrientation,
  orientationOpts = {},
  catalog = null,
  githubReviews = [],
  envVars = {},
  chatMemory = null,
  persist = true,
  requireSharedStore = false,
} = {}) {
  void chatMemory; // Chat/automation memory cannot override Git/control state.
  const normalizedTrigger = assertTrigger(trigger);
  assertNoBusinessCredentials(envVars);

  const owner = sandboxOwnerId(process.env);
  if (requireSharedStore && core?.store?.kind !== BUILDER_STORE_KIND.POSTGRES) {
    return blockedStoreDecision('SHARED_STORE_REQUIRED');
  }

  let lock;
  try {
    lock = acquireTickLock(root);
  } catch (err) {
    if (err instanceof TickLockError && err.code === 'DUPLICATE_TRIGGER') {
      return decisionFields({
        decision: TICK_DECISIONS.NOOP,
        reason: 'DUPLICATE_TRIGGER',
      }, providedOrientation, normalizedTrigger);
    }
    throw err;
  }

  try {
    const orientation = providedOrientation || await runOrientationFn(root, {
      persistEvidence: false,
      ...orientationOpts,
    });
    const approved = catalog || loadApprovedWorkCatalog(root);
    const recovery = await core.recover();
    const selected = await selectOne({
      core,
      orientation,
      catalog: approved,
      githubReviews,
      recovery,
      owner,
    });

    if (
      selected.decision === TICK_DECISIONS.NOOP ||
      selected.decision === TICK_DECISIONS.NEEDS_OWNER ||
      selected.decision === TICK_DECISIONS.BLOCKED
    ) {
      const out = decisionFields(selected, orientation, normalizedTrigger);
      if (persist) persistTickDecision(root, out);
      return out;
    }

    let task = selected.task;
    let alreadyClaimed = false;
    if (!task && selected.work) {
      const claimed = await claimOrReuse(core, selected.work);
      if (claimed?.stop) {
        const stopped = decisionFields({
          decision: claimed.stop,
          task_id: claimed.task.task_id,
          reason: claimed.reason,
          owner_action: claimed.stop === TICK_DECISIONS.NEEDS_OWNER
            ? 'Owner must unblock or re-authorize this Builder task.'
            : null,
        }, orientation, normalizedTrigger);
        if (persist) persistTickDecision(root, stopped);
        return stopped;
      }
      task = claimed?.task || claimed;
      alreadyClaimed = Boolean(claimed?.already_claimed);
    }
    if (!task) {
      const out = decisionFields({
        decision: TICK_DECISIONS.NOOP,
        reason: 'NO_ELIGIBLE_WORK',
      }, orientation, normalizedTrigger);
      if (persist) persistTickDecision(root, out);
      return out;
    }

    if (alreadyClaimed) {
      const current = await settle(core.getCurrentCodingRun());
      if (current) {
        const out = decisionFields({
          decision: TICK_DECISIONS.NOOP,
          reason: current.provider_run_id ? 'WORKER_IN_FLIGHT' : 'ALREADY_CLAIMED',
          task_id: task.task_id,
          factory_run_id: current.factory_run_id,
          provider_run_id: current.provider_run_id || null,
          logical_work_id: selected.work?.work_id || task.logical_work_id || task.task_id,
        }, orientation, normalizedTrigger);
        if (persist) persistTickDecision(root, out);
        return out;
      }
    }

    let factoryRunId = selected.factory_run_id || null;
    if (selected.decision === TICK_DECISIONS.REPAIR) {
      await invalidateTaskEvidence(core, task.task_id, selected.reason || 'repair');
      const repair = await settle(beginRepairAttempt(core, task.task_id, {
        failure_class: selected.reason === 'CI_FAILED'
          ? FAILURE_CLASS.CI_FAIL
          : FAILURE_CLASS.UNKNOWN,
        reason: selected.reason || 'repair',
        provider: 'cursor',
      }));
      if (!repair.allowed) {
        const blocked = decisionFields({
          decision: repair.stop_status === TASK_STATUS.NEEDS_OWNER
            ? TICK_DECISIONS.NEEDS_OWNER
            : TICK_DECISIONS.BLOCKED,
          task_id: task.task_id,
          reason: repair.reason,
        }, orientation, normalizedTrigger);
        if (persist) persistTickDecision(root, blocked);
        return blocked;
      }
      factoryRunId = repair.run.factory_run_id;
      task = repair.task;
    } else if (!factoryRunId) {
      const inserted = await settle(core.store.tryInsertActiveRun({
        task_id: task.task_id,
        provider: 'cursor',
        owner,
        factory_run_id: newFactoryRunId(),
      }));
      if (!inserted.inserted) {
        const existingRun = inserted.run;
        const out = decisionFields({
          decision: TICK_DECISIONS.NOOP,
          reason: existingRun?.provider_run_id ? 'WORKER_IN_FLIGHT' : (inserted.reason || 'ALREADY_CLAIMED'),
          task_id: task.task_id,
          factory_run_id: existingRun?.factory_run_id || null,
          provider_run_id: existingRun?.provider_run_id || null,
          logical_work_id: selected.work?.work_id || task.logical_work_id || task.task_id,
        }, orientation, normalizedTrigger);
        if (persist) persistTickDecision(root, out);
        return out;
      }
      factoryRunId = inserted.run.factory_run_id;
      core._currentFactoryRunId = factoryRunId;
      await settle(core.store.appendEvent({
        task_id: task.task_id,
        factory_run_id: factoryRunId,
        event_type: EVENT_TYPE.RUN_CREATED,
        payload: { attempt: inserted.run.attempt, provider: 'cursor' },
      }));
    }

    const contractPath = writeWorkerContract(root, {
      task,
      factory_run_id: factoryRunId,
      head_sha: orientation.head_sha,
      orientation,
      verification_commands: (orientation.completion_proof?.commands || []).map((name) =>
        name.startsWith('npm') ? name : ('npm run ' + name)
      ),
    });

    const launched = await maybeDispatch({
      core,
      task,
      factoryRunId,
      dispatch,
      prompt: buildPrompt(task, contractPath),
    });

    const out = decisionFields({
      decision: selected.decision,
      task_id: task.task_id,
      factory_run_id: launched.factory_run_id || factoryRunId,
      provider_run_id: launched.provider_run_id,
      provider: launched.provider || 'cursor',
      worker_contract: contractPath,
      pr: selected.pr || null,
      head_sha: orientation.head_sha,
      reason: selected.reason,
      logical_work_id: selected.work?.work_id || task.logical_work_id || task.task_id,
      dispatched: launched.dispatched,
    }, orientation, normalizedTrigger);
    if (persist) persistTickDecision(root, out);
    return out;
  } finally {
    lock.release();
  }
}

export async function tickProviderStatus(core, factoryRunId) {
  return core.refreshWorkerStatus(factoryRunId);
}

export async function tickProviderCancel(core, factoryRunId) {
  return core.cancelCodingWorker(factoryRunId);
}

export async function tickProviderCollect(core, factoryRunId, opts = {}) {
  return core.collectCodingWorker(factoryRunId, opts);
}
