// Deterministic jarvis:tick control-plane tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createBuilderCore,
  createCursorProvider,
  TASK_STATUS,
  RUN_STATUS,
  CANDIDATE_STATUS,
  REVIEW_STATUS,
  VERIFICATION_RESULT,
  PROVIDER_STATUS,
  newCandidateId,
} from '../src/builder/index.js';
import {
  runJarvisTick,
  nextEligibleApprovedWork,
  stableTaskId,
  isForbiddenScope,
  TICK_DECISIONS,
} from '../src/builder/tick.js';
import { acquireTickLock } from '../src/builder/tick-lock.js';
import { FOUNDATION_SLICES } from '../scripts/build-runner.mjs';

const REAL_ROOT = new URL('../', import.meta.url).pathname;
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makeRoot() {
  const root = join(tmpdir(), 'jarvis-tick-' + Math.random().toString(36).slice(2));
  mkdirSync(join(root, 'control'), { recursive: true });
  cpSync(join(REAL_ROOT, 'control/prd.json'), join(root, 'control/prd.json'));
  return root;
}

function catalog() {
  return JSON.parse(readFileSync(join(REAL_ROOT, 'control/prd.json'), 'utf8'));
}

function orientationFixture(overrides = {}) {
  return {
    head_sha: SHA,
    current_phase: 'V1.0C',
    next_phase_candidate: 'V1.1',
    active_work_state: 'IMPLEMENTATION_SLICE',
    completed_deterministic_gates: ['BUILDER_STAGE_1', 'V1.0A', 'V1.0B', 'V1.0C'],
    completed_implementation_slices: ['F-01'],
    implementation_slices: {
      completed: ['F-01'],
      next: { phase_id: 'F-02', phase_name: 'Owner authentication / MFA skeleton' },
      status: 'F-02',
    },
    owner_blockers: ['owner must select the first bounded T2 routine'],
    live_verification_blockers: [{ id: 'postgres-tenant-boundary', title: 'Postgres / tenant boundary live verification' }],
    claim_task: { via: 'run-next-phase', dispatch: false },
    completion_proof: { commands: ['verify:sot'] },
    advance_allowed: false,
    ...overrides,
  };
}

function fakeProvider({ onLaunch } = {}) {
  const launches = [];
  return {
    name: 'cursor',
    launches,
    async launch(args) {
      if (onLaunch) onLaunch(args);
      launches.push(args);
      return {
        factory_run_id: args.factory_run_id,
        provider: 'cursor',
        provider_run_id: 'prov_fake_1',
        provider_agent_id: 'bc-fake-1',
        provider_status: PROVIDER_STATUS.LAUNCHED,
        evidence: { runtime: 'fake' },
        error: null,
      };
    },
    async status(args) {
      return { ...args, provider: 'cursor', provider_status: PROVIDER_STATUS.RUNNING, evidence: {}, error: null };
    },
    async cancel(args) {
      return { ...args, provider: 'cursor', provider_status: PROVIDER_STATUS.CANCELLED, evidence: {}, error: null };
    },
    async collect(args) {
      return { ...args, provider: 'cursor', provider_status: PROVIDER_STATUS.FINISHED, evidence: {}, error: null };
    },
  };
}

function coreWith(provider) {
  return createBuilderCore({ dbPath: ':memory:', workerProvider: provider || fakeProvider() });
}

async function tick(opts) {
  return runJarvisTick({
    persist: true,
    dispatch: false,
    catalog: catalog(),
    orientation: orientationFixture(),
    ...opts,
  });
}

test('future-phase work cannot be selected', () => {
  const work = nextEligibleApprovedWork(orientationFixture({
    implementation_slices: { next: { phase_id: 'V1.1', phase_name: 'First Bounded T2' }, status: 'V1.1' },
    completed_implementation_slices: FOUNDATION_SLICES.map((s) => s.phase_id),
    completed_deterministic_gates: ['BUILDER_STAGE_1', 'V1.0A', 'V1.0B', 'V1.0C'],
  }), catalog());
  assert.notEqual(work?.work_id, 'V1.1');
  assert.equal(isForbiddenScope('hermes voice'), true);
  assert.equal(isForbiddenScope('obsidian'), true);
  assert.equal(isForbiddenScope('prime'), true);
});

test('only dependency-ready work is eligible', () => {
  const work = nextEligibleApprovedWork(orientationFixture(), catalog());
  assert.equal(work.work_id, 'F-02');
  const later = nextEligibleApprovedWork(orientationFixture({
    implementation_slices: { next: { phase_id: 'F-03', phase_name: 'Tenants' }, status: 'F-03' },
    completed_implementation_slices: ['F-01', 'F-02'],
  }), catalog());
  assert.equal(later.work_id, 'F-03');
  const live = nextEligibleApprovedWork(orientationFixture({
    implementation_slices: { next: null, status: 'V1_0_COMPLETE' },
    completed_implementation_slices: FOUNDATION_SLICES.map((s) => s.phase_id),
    completed_deterministic_gates: ['BUILDER_STAGE_1'],
    active_work_state: 'LIVE_VERIFICATION_CLOSURE',
  }), catalog());
  assert.equal(live, null, 'live work is not eligible before V1.0A PASS');
});

test('NOOP occurs when no work is eligible', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    const decision = await tick({
      root,
      trigger: 'hourly',
      core,
      orientation: orientationFixture({
        implementation_slices: { next: null, status: 'V1_0_COMPLETE' },
        completed_implementation_slices: FOUNDATION_SLICES.map((s) => s.phase_id),
        completed_deterministic_gates: [],
        owner_blockers: [],
        claim_task: { via: 'NO_WORK', dispatch: false },
        active_work_state: 'NO_ELIGIBLE_WORK',
      }),
    });
    assert.equal(decision.decision, TICK_DECISIONS.NOOP);
    assert.equal(decision.reason, 'NO_ELIGIBLE_WORK');
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('NEEDS_OWNER occurs when owner authority is required', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    const decision = await tick({
      root,
      trigger: 'hourly',
      core,
      orientation: orientationFixture({
        implementation_slices: { next: null, status: 'V1_0_COMPLETE' },
        completed_implementation_slices: FOUNDATION_SLICES.map((s) => s.phase_id),
        completed_deterministic_gates: ['BUILDER_STAGE_1'],
        claim_task: { via: 'WAITING_ON_OWNER', dispatch: false },
        active_work_state: 'WAITING_ON_OWNER',
      }),
    });
    assert.equal(decision.decision, TICK_DECISIONS.NEEDS_OWNER);
    assert.equal(decision.reason, 'FIRST_BOUNDED_T2_NOT_SELECTED');
    assert.match(decision.owner_action, /T2/);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('EXECUTE uses the existing Builder Core claim path', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    const decision = await tick({ root, trigger: 'hourly', core });
    assert.equal(decision.decision, TICK_DECISIONS.EXECUTE);
    assert.equal(decision.reason, 'NEXT_DEPENDENCY_READY_TASK');
    assert.equal(decision.task_id, stableTaskId('F-02'));
    assert.ok(decision.factory_run_id.startsWith('run_'));
    const task = core.getTask(decision.task_id);
    assert.ok(task);
    assert.notEqual(task.status, TASK_STATUS.DRAFT);
    assert.ok(task.content_hash);
    assert.equal(existsSync(join(root, decision.worker_contract)), true);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('one tick selects at most one logical objective', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    const decision = await tick({ root, trigger: 'hourly', core });
    assert.equal(decision.decision, TICK_DECISIONS.EXECUTE);
    assert.equal(core.store.listTasks().length, 1);
    assert.equal(core.store.listRunsForTask(decision.task_id).length, 1);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing failed or unfinished work outranks new work', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    const existing = core.createAndLockTask({
      task_id: 'task_existing_failed',
      intent: 'repair me',
      acceptance_ref: 'tests/jarvis-tick.test.mjs',
      allowed_paths: ['src/builder/'],
      tool_manifest: { providers: ['cursor'], tools: ['coding_worker'], mode: 'build' },
    });
    core.updateTaskStatus(existing.task_id, TASK_STATUS.FAILED);
    const decision = await tick({ root, trigger: 'checks_failed', core });
    assert.equal(decision.decision, TICK_DECISIONS.REPAIR);
    assert.equal(decision.task_id, 'task_existing_failed');
    assert.notEqual(decision.task_id, stableTaskId('F-02'));
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate triggers do not duplicate task claims', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    const first = await tick({ root, trigger: 'hourly', core });
    assert.equal(first.decision, TICK_DECISIONS.EXECUTE);
    const lock = acquireTickLock(root);
    const second = await tick({ root, trigger: 'hourly', core });
    lock.release();
    assert.equal(second.decision, TICK_DECISIONS.NOOP);
    assert.equal(second.reason, 'DUPLICATE_TRIGGER');
    assert.equal(core.store.listTasks().length, 1);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale runs cannot update authoritative state', async () => {
  const root = makeRoot();
  const provider = fakeProvider();
  const core = coreWith(provider);
  try {
    const task = core.createAndLockTask({
      intent: 'stale fence',
      acceptance_ref: 'tests/jarvis-tick.test.mjs',
      allowed_paths: ['src/builder/'],
      tool_manifest: { providers: ['cursor'], tools: ['coding_worker'], mode: 'build' },
    });
    const run = core.createRun({ task_id: task.task_id, provider: 'cursor' });
    core.markRunStale(run.factory_run_id);
    assert.throws(
      () => core.applyProviderResult(run.factory_run_id, {
        factory_run_id: run.factory_run_id,
        provider: 'cursor',
        provider_status: PROVIDER_STATUS.FINISHED,
        evidence: {},
      }),
      /stale/i
    );
    const decision = await tick({ root, trigger: 'hourly', core });
    assert.ok(decision.factory_run_id);
    assert.notEqual(decision.factory_run_id, run.factory_run_id);
    assert.equal(core.getRun(run.factory_run_id).status, RUN_STATUS.STALE);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('CursorProvider is invoked through the existing SDK integration', async () => {
  const root = makeRoot();
  const sdk = {
    agents: [],
    async listModels() { return [{ id: 'composer-2.5' }]; },
    async createAgent(options) {
      this.agents.push(options);
      return {
        agentId: 'bc-sdk-fake',
        send: async () => ({
          id: 'run-sdk-fake',
          status: 'running',
          supports: () => true,
          wait: async () => ({ status: 'finished', result: 'ok', git: { branches: [] } }),
        }),
      };
    },
    async getRun() { return { status: 'running' }; },
    async cancelRun() {},
  };
  const provider = createCursorProvider({
    apiKey: 'cursor_test_key_not_production',
    sdkAdapter: sdk,
    autoCreatePR: false,
  });
  const core = createBuilderCore({ dbPath: ':memory:', workerProvider: provider });
  try {
    const decision = await tick({
      root,
      trigger: 'manual_smoke',
      core,
      dispatch: true,
    });
    assert.equal(decision.decision, TICK_DECISIONS.EXECUTE);
    assert.equal(decision.dispatched, true);
    assert.equal(decision.provider, 'cursor');
    assert.equal(decision.provider_run_id, 'run-sdk-fake');
    assert.equal(sdk.agents.length, 1);
    assert.ok(sdk.agents[0].cloud.repos[0].url.includes('jarvis-agencyos'));
    assert.equal(JSON.stringify(provider).includes('cursor_test_key_not_production'), false);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fake test provider can validate dispatch without spending cloud credits', async () => {
  const root = makeRoot();
  const provider = fakeProvider();
  const core = coreWith(provider);
  try {
    const decision = await tick({
      root,
      trigger: 'manual_smoke',
      core,
      dispatch: true,
    });
    assert.equal(decision.dispatched, true);
    assert.equal(provider.launches.length, 1);
    assert.equal(provider.launches[0].factory_run_id, decision.factory_run_id);
    assert.match(provider.launches[0].prompt, /Do not set PASS\/DONE/);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate changes invalidate prior evidence', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    const task = core.createAndLockTask({
      task_id: 'task_ci_failed',
      intent: 'failed ci',
      acceptance_ref: 'tests/jarvis-tick.test.mjs',
      allowed_paths: ['src/builder/'],
      tool_manifest: { providers: ['cursor'], tools: ['coding_worker'], mode: 'build' },
    });
    const run = core.createRun({ task_id: task.task_id, provider: 'cursor' });
    core.store.updateRun(run.factory_run_id, { status: RUN_STATUS.SUCCEEDED, ended_at: new Date().toISOString() });
    const candidate = core.store.insertCandidate({
      candidate_id: newCandidateId(),
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'cursor/failed',
      commit_sha: SHA,
      pr_number: 107,
      ci_status: 'completed',
      ci_conclusion: 'failure',
      status: CANDIDATE_STATUS.PROPOSED,
    });
    const verification = core.store.insertVerification({
      verification_id: 'ver_old',
      candidate_id: candidate.candidate_id,
      commit_sha: SHA,
      result: VERIFICATION_RESULT.PASS,
      checks: [],
    });
    core.updateTaskStatus(task.task_id, TASK_STATUS.FAILED);
    const decision = await tick({ root, trigger: 'checks_failed', core });
    assert.equal(decision.decision, TICK_DECISIONS.REPAIR);
    assert.equal(decision.reason, 'CI_FAILED');
    assert.equal(decision.pr, 107);
    assert.notEqual(decision.factory_run_id, run.factory_run_id);
    const after = core.store.getVerification(verification.verification_id);
    assert.ok(after.invalidated_at);
    assert.equal(core.store.getCandidate(candidate.candidate_id).status, CANDIDATE_STATUS.SUPERSEDED);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker cannot set PASS/DONE', async () => {
  const root = makeRoot();
  const provider = fakeProvider({
    onLaunch: (args) => {
      args.task_done = true;
      args.task_accepted = true;
    },
  });
  const core = coreWith(provider);
  try {
    const decision = await tick({ root, trigger: 'hourly', core, dispatch: true });
    assert.equal(decision.decision, TICK_DECISIONS.EXECUTE);
    const task = core.getTask(decision.task_id);
    assert.notEqual(task.status, TASK_STATUS.ACCEPTED);
    assert.notEqual(task.status, TASK_STATUS.VERIFIED);
    const contract = readFileSync(join(root, decision.worker_contract), 'utf8');
    assert.match(contract, /Do not set PASS, DONE, ACCEPTED/);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('phase advancement cannot be invoked by the worker', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    const decision = await tick({ root, trigger: 'hourly', core, dispatch: true });
    const contract = readFileSync(join(root, decision.worker_contract), 'utf8');
    assert.match(contract, /Do not advance phases/);
    assert.equal(Object.prototype.hasOwnProperty.call(decision, 'advance_phase'), false);
    assert.equal(existsSync(join(root, 'artifacts/build-runner/current-phase.json')), false);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('automation memory or chat cannot override Git or control state', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    const decision = await tick({
      root,
      trigger: 'hourly',
      core,
      chatMemory: {
        current_phase: 'V1.1',
        select: 'hermes',
        task_id: 'task_from_chat',
      },
    });
    assert.equal(decision.task_id, stableTaskId('F-02'));
    assert.notEqual(decision.task_id, 'task_from_chat');
    assert.notEqual(decision.head_sha, 'from-chat');
    assert.equal(decision.head_sha, SHA);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('no production credentials are introduced', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    await assert.rejects(
      () => tick({
        root,
        trigger: 'hourly',
        core,
        envVars: { STRIPE_SECRET_KEY: 'sk_live_fake' },
      }),
      /business credential/i
    );
    const prd = readFileSync(join(REAL_ROOT, 'control/prd.json'), 'utf8');
    assert.doesNotMatch(prd, /sk_live|CURSOR_API_KEY|password/i);
    const decision = await tick({ root, trigger: 'hourly', core });
    assert.equal(JSON.stringify(decision).includes('sk_live'), false);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('in-flight worker is not killed and sequential ticks reuse the claimed task', async () => {
  const root = makeRoot();
  const provider = fakeProvider();
  const core = coreWith(provider);
  try {
    const first = await tick({ root, trigger: 'hourly', core, dispatch: true });
    assert.equal(first.decision, TICK_DECISIONS.EXECUTE);
    const second = await tick({ root, trigger: 'hourly', core, dispatch: true });
    assert.equal(second.decision, TICK_DECISIONS.NOOP);
    assert.equal(second.reason, 'WORKER_IN_FLIGHT');
    assert.equal(second.task_id, first.task_id);
    assert.equal(second.factory_run_id, first.factory_run_id);
    assert.equal(core.store.listTasks().length, 1);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('changes-requested unfinished PR outranks new approved work', async () => {
  const root = makeRoot();
  const core = coreWith();
  try {
    const task = core.createAndLockTask({
      task_id: 'task_review',
      intent: 'address review',
      acceptance_ref: 'tests/jarvis-tick.test.mjs',
      allowed_paths: ['src/builder/'],
      tool_manifest: { providers: ['cursor'], tools: ['coding_worker'], mode: 'build' },
    });
    const decision = await tick({
      root,
      trigger: 'changes_requested',
      core,
      githubReviews: [{ task_id: task.task_id, pr: 42, status: REVIEW_STATUS.REQUEST_CHANGES }],
    });
    assert.equal(decision.decision, TICK_DECISIONS.REPAIR);
    assert.equal(decision.reason, 'CHANGES_REQUESTED');
    assert.equal(decision.task_id, 'task_review');
    assert.equal(decision.pr, 42);
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
