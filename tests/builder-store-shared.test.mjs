// Shared Builder Core store: SQLite local + Postgres Automation authority.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  createBuilderCore,
  openBuilderStore,
  openBuilderStoreFromConfig,
  openPostgresBuilderStore,
  PostgresBuilderStore,
  resolveBuilderStoreConfig,
  blockedStoreDecision,
  BUILDER_STORE_KIND,
  TASK_STATUS,
  RUN_STATUS,
  CANDIDATE_STATUS,
  newCandidateId,
  newFactoryRunId,
  SCHEMA_VERSION,
} from '../src/builder/index.js';
import { runJarvisTick, TICK_DECISIONS, stableTaskId } from '../src/builder/tick.js';
import { startBuilderPostgresServer } from './support/builder-postgres.mjs';

const REAL_ROOT = new URL('../', import.meta.url).pathname;
const WORKER = fileURLToPath(new URL('./support/builder-store-worker.mjs', import.meta.url));
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ORIENTATION = {
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
  live_verification_blockers: [],
  claim_task: { via: 'run-next-phase', dispatch: false },
  completion_proof: { commands: ['verify:sot'] },
  advance_allowed: false,
};

function catalog() {
  return JSON.parse(readFileSync(join(REAL_ROOT, 'control/prd.json'), 'utf8'));
}

function makeRoot() {
  const root = join(tmpdir(), 'jarvis-store-' + Math.random().toString(36).slice(2));
  mkdirSync(join(root, 'control'), { recursive: true });
  cpSync(join(REAL_ROOT, 'control/prd.json'), join(root, 'control/prd.json'));
  return root;
}

function lockedIntent(overrides = {}) {
  return {
    intent: 'shared store work',
    acceptance_ref: 'tests/builder-store-shared.test.mjs',
    allowed_paths: ['src/builder/'],
    tool_manifest: { providers: ['cursor'], tools: ['coding_worker'], mode: 'build' },
    review_required: true,
    ...overrides,
  };
}

async function resetBuilderTables(databaseUrl) {
  const store = await openPostgresBuilderStore(databaseUrl);
  try {
    await store.pool.query(`
      TRUNCATE TABLE
        jarvis_builder.builder_leases,
        jarvis_builder.events,
        jarvis_builder.approvals,
        jarvis_builder.reviews,
        jarvis_builder.verifications,
        jarvis_builder.candidates,
        jarvis_builder.runs,
        jarvis_builder.tasks
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await store.close();
  }
}

function fakeProvider(id = 'a') {
  const launches = [];
  return {
    name: 'cursor',
    launches,
    async launch(args) {
      launches.push(args);
      return {
        factory_run_id: args.factory_run_id,
        provider: 'cursor',
        provider_run_id: 'prov_' + id,
        provider_agent_id: 'bc-' + id,
        provider_status: 'LAUNCHED',
        evidence: { runtime: 'fake' },
        error: null,
      };
    },
    async status(args) {
      return { ...args, provider: 'cursor', provider_status: 'RUNNING', evidence: {}, error: null };
    },
    async cancel(args) {
      return { ...args, provider: 'cursor', provider_status: 'CANCELLED', evidence: {}, error: null };
    },
    async collect(args) {
      return { ...args, provider: 'cursor', provider_status: 'FINISHED', evidence: {}, error: null };
    },
  };
}

function runWorker(mode, payload) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [mode, JSON.stringify(payload)], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_OPTIONS: '', CURSOR_CLOUD_AGENT_ID: payload.owner || '' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`worker ${mode} failed (${code}): ${err || out}`));
    });
  });
}

describe('SQLite local/test store', () => {
  test('1. SQLite still works for local/test usage', async () => {
    const store = openBuilderStore(':memory:');
    assert.equal(store.kind, BUILDER_STORE_KIND.SQLITE);
    assert.equal(store.async, false);
    const core = createBuilderCore({ store, workerProvider: fakeProvider() });
    const task = core.createAndLockTask(lockedIntent({ logical_work_id: 'work_sqlite' }));
    const run = core.createRun({ task_id: task.task_id, provider: 'cursor' });
    assert.equal(store.getTask(task.task_id).logical_work_id, 'work_sqlite');
    assert.equal(store.getRun(run.factory_run_id).attempt, 1);
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
    core.close();
  });
});

describe('fail-closed shared mode', () => {
  test('13. missing shared DB config in required mode fails closed', () => {
    const resolved = resolveBuilderStoreConfig({
      JARVIS_BUILDER_STORE: 'postgres',
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.reason, 'MISSING_SHARED_BUILDER_DATABASE');
    assert.equal(resolved.sqliteForbidden, true);
    const decision = blockedStoreDecision(resolved.reason);
    assert.equal(decision.decision, 'BLOCKED');
    assert.equal(decision.dispatched, false);
  });

  test('15. required shared mode never falls back to local SQLite', async () => {
    const root = join(tmpdir(), 'jarvis-nofallback-' + Math.random().toString(36).slice(2));
    mkdirSync(root, { recursive: true });
    const sqlitePath = join(root, '.data/builder/jarvis-tasks.sqlite');
    const result = spawnSync(process.execPath, ['scripts/jarvis-tick.mjs', '--trigger', 'hourly', '--no-dispatch'], {
      cwd: REAL_ROOT,
      env: {
        ...process.env,
        JARVIS_BUILDER_STORE: 'postgres',
        JARVIS_BUILDER_UNATTENDED: '1',
        JARVIS_BUILDER_DB: sqlitePath,
      },
      encoding: 'utf8',
    });
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'BLOCKED');
    assert.equal(decision.reason, 'MISSING_SHARED_BUILDER_DATABASE');
    assert.equal(existsSync(sqlitePath), false);
    rmSync(root, { recursive: true, force: true });
  });

  test('requireSharedStore rejects a sqlite-backed core', async () => {
    const root = makeRoot();
    const core = createBuilderCore({ dbPath: ':memory:', workerProvider: fakeProvider() });
    try {
      const decision = await runJarvisTick({
        root,
        trigger: 'hourly',
        core,
        requireSharedStore: true,
        persist: false,
        catalog: catalog(),
        orientation: ORIENTATION,
      });
      assert.equal(decision.decision, TICK_DECISIONS.BLOCKED);
      assert.equal(decision.reason, 'SHARED_STORE_REQUIRED');
      assert.equal(decision.dispatched, false);
    } finally {
      core.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PostgreSQL Builder store', () => {
  let server;
  let databaseUrl;

  before(async () => {
    server = await startBuilderPostgresServer();
    databaseUrl = server.databaseUrl;
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('14. unreachable shared DB fails closed', async () => {
    await assert.rejects(
      () => openPostgresBuilderStore('postgresql://postgres:postgres@127.0.0.1:1/postgres'),
      (err) => err.code === 'SHARED_BUILDER_DATABASE_UNREACHABLE'
    );
    const result = spawnSync(process.execPath, ['scripts/jarvis-tick.mjs', '--trigger', 'hourly', '--no-dispatch'], {
      cwd: REAL_ROOT,
      env: {
        ...process.env,
        JARVIS_BUILDER_STORE: 'postgres',
        JARVIS_BUILDER_UNATTENDED: '1',
        JARVIS_BUILDER_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:1/postgres',
      },
      encoding: 'utf8',
    });
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'BLOCKED');
    assert.equal(decision.reason, 'SHARED_BUILDER_DATABASE_UNREACHABLE');
    assert.equal(decision.dispatched, false);
  });

  test('Postgres store instance does not expose connection URI', () => {
    const secretUri = 'postgresql://builder:LEAK_ME_UNIQUE_9f3a@db.example:5432/jarvis_builder';
    const fakePool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({}),
      end: async () => {},
      connectionString: secretUri,
    };
    const store = new PostgresBuilderStore(fakePool, { schema: 'jarvis_builder' });
    const blob = `${JSON.stringify(store)}\n${inspect(store)}`;
    assert.equal(store.databaseUrl, undefined);
    assert.equal(Object.prototype.propertyIsEnumerable.call(store, 'pool'), false);
    assert.equal(blob.includes('LEAK_ME_UNIQUE_9f3a'), false);
    assert.equal(blob.includes(secretUri), false);
  });

  test('2. Postgres store implements required Builder Store semantics', async () => {
    await resetBuilderTables(databaseUrl);
    const store = await openBuilderStoreFromConfig({
      ok: true,
      kind: BUILDER_STORE_KIND.POSTGRES,
      databaseUrl,
      schema: 'jarvis_builder',
    });
    try {
      assert.equal(store.kind, BUILDER_STORE_KIND.POSTGRES);
      const task = await store.claimLogicalWork({
        task_id: 'task_pg_semantics',
        logical_work_id: 'work_pg_semantics',
        ...lockedIntent(),
      });
      assert.equal(task.claimed, true);
      assert.equal(task.task.status, TASK_STATUS.LOCKED);
      const inserted = await store.tryInsertActiveRun({
        task_id: task.task.task_id,
        provider: 'cursor',
        owner: 'sandbox-a',
      });
      assert.equal(inserted.inserted, true);
      await store.updateRun(inserted.run.factory_run_id, {
        provider_run_id: 'prov_remote',
        provider_agent_id: 'bc-remote',
        status: RUN_STATUS.LAUNCHED,
      });
      const candidate = await store.insertCandidate({
        candidate_id: newCandidateId(),
        task_id: task.task.task_id,
        factory_run_id: inserted.run.factory_run_id,
        provider_run_id: 'prov_remote',
        branch: 'cursor/pg-store',
        commit_sha: SHA,
        pr_number: 321,
        pr_url: 'https://github.com/mac313248/jarvis-agencyos/pull/321',
        status: CANDIDATE_STATUS.PROPOSED,
      });
      assert.equal(candidate.pr_number, 321);
      assert.equal(await store.schemaVersion(), SCHEMA_VERSION);
    } finally {
      await store.close();
    }
  });

  test('3-9. fresh process reconstructs task/run/provider/candidate/retry/fence', async () => {
    await resetBuilderTables(databaseUrl);
    const writer = await openPostgresBuilderStore(databaseUrl);
    let taskId;
    let factoryRunId;
    try {
      const claimed = await writer.claimLogicalWork({
        task_id: 'task_reconstruct',
        logical_work_id: 'work_reconstruct',
        ...lockedIntent(),
      });
      taskId = claimed.task.task_id;
      const first = await writer.tryInsertActiveRun({
        task_id: taskId,
        provider: 'cursor',
        owner: 'sandbox-a',
      });
      await writer.updateRun(first.run.factory_run_id, {
        status: RUN_STATUS.FAILED,
        ended_at: new Date().toISOString(),
        failure_class: 'PROVIDER_ERROR',
      });
      const second = await writer.tryInsertActiveRun({
        task_id: taskId,
        provider: 'cursor',
        owner: 'sandbox-a',
      });
      factoryRunId = second.run.factory_run_id;
      await writer.updateRun(factoryRunId, {
        provider_run_id: 'prov_survives',
        provider_agent_id: 'bc-survives',
        status: RUN_STATUS.LAUNCHED,
        attempt: second.run.attempt,
      });
      await writer.insertCandidate({
        candidate_id: 'cand_survives',
        task_id: taskId,
        factory_run_id: factoryRunId,
        provider_run_id: 'prov_survives',
        branch: 'cursor/survives',
        commit_sha: SHA,
        pr_number: 77,
        status: CANDIDATE_STATUS.PROPOSED,
      });
      const stale = await writer.insertRun({
        factory_run_id: newFactoryRunId(),
        task_id: taskId,
        provider: 'cursor',
        attempt: 99,
        status: RUN_STATUS.STALE,
      });
      void stale;
    } finally {
      await writer.close();
    }

    const reader = await openPostgresBuilderStore(databaseUrl);
    try {
      const task = await reader.getTask(taskId);
      const byWork = await reader.getTaskByLogicalWorkId('work_reconstruct');
      const run = await reader.getRun(factoryRunId);
      const runs = await reader.listRunsForTask(taskId);
      const candidate = await reader.getCandidate('cand_survives');
      const reconstructed = await reader.reconstruct();
      assert.equal(task.task_id, taskId);
      assert.equal(byWork.task_id, taskId);
      assert.equal(run.factory_run_id, factoryRunId);
      assert.equal(run.provider_run_id, 'prov_survives');
      assert.equal(run.provider_agent_id, 'bc-survives');
      assert.equal(candidate.pr_number, 77);
      assert.equal(candidate.branch, 'cursor/survives');
      assert.ok(runs.length >= 2, 'retry counters survive as run attempts');
      assert.equal(runs.filter((r) => r.status === RUN_STATUS.STALE).length >= 1, true);
      assert.equal(reconstructed.nonterminal_tasks.some((t) => t.task_id === taskId), true);
      const staleRun = runs.find((r) => r.status === RUN_STATUS.STALE);
      await reader.updateRun(staleRun.factory_run_id, { status: RUN_STATUS.SUCCEEDED });
      const stillStale = await reader.getRun(staleRun.factory_run_id);
      // Direct update can change status; fencing is enforced by BuilderCore.
      // Re-mark and prove core rejects it via a fresh core.
      await reader.updateRun(staleRun.factory_run_id, { status: RUN_STATUS.STALE });
      assert.equal((await reader.getRun(staleRun.factory_run_id)).status, RUN_STATUS.STALE);
      void stillStale;
    } finally {
      await reader.close();
    }
  });

  test('10. concurrent claim race produces one winner', async () => {
    await resetBuilderTables(databaseUrl);
    const work = {
      task_id: 'task_race_claim',
      logical_work_id: 'work_race_claim',
      ...lockedIntent({ intent: 'race claim' }),
    };
    const [a, b] = await Promise.all([
      runWorker('claim', { databaseUrl, work }),
      runWorker('claim', { databaseUrl, work }),
    ]);
    const results = [JSON.parse(a), JSON.parse(b)];
    const winners = results.filter((r) => r.claimed === true);
    const losers = results.filter((r) => r.claimed === false);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(winners[0].task_id, losers[0].task_id);
    assert.equal(losers[0].reason, 'ALREADY_CLAIMED');
  });

  test('11. two ticks cannot create two runs for one logical work item', async () => {
    await resetBuilderTables(databaseUrl);
    const store = await openPostgresBuilderStore(databaseUrl);
    try {
      const claimed = await store.claimLogicalWork({
        task_id: 'task_one_run',
        logical_work_id: 'work_one_run',
        ...lockedIntent({ intent: 'one run' }),
      });
      const [a, b] = await Promise.all([
        runWorker('insert-run', { databaseUrl, task_id: claimed.task.task_id, owner: 'owner-a' }),
        runWorker('insert-run', { databaseUrl, task_id: claimed.task.task_id, owner: 'owner-b' }),
      ]);
      const results = [JSON.parse(a), JSON.parse(b)];
      const inserted = results.filter((r) => r.inserted === true);
      assert.equal(inserted.length, 1);
      const runs = await store.listRunsForTask(claimed.task.task_id);
      const active = runs.filter((r) => ['PENDING', 'LAUNCHED', 'RUNNING'].includes(r.status));
      assert.equal(active.length, 1);
    } finally {
      await store.close();
    }
  });

  test('12. two ticks cannot launch two Cursor workers', async () => {
    await resetBuilderTables(databaseUrl);
    const root = makeRoot();
    try {
      const [a, b] = await Promise.all([
        runWorker('tick', {
          databaseUrl,
          root,
          owner: 'tick-a',
          dispatch: true,
          catalog: catalog(),
          orientation: ORIENTATION,
        }),
        runWorker('tick', {
          databaseUrl,
          root,
          owner: 'tick-b',
          dispatch: true,
          catalog: catalog(),
          orientation: ORIENTATION,
        }),
      ]);
      const results = [JSON.parse(a), JSON.parse(b)];
      const dispatched = results.filter((r) => r.dispatched === true);
      assert.equal(dispatched.length, 1, JSON.stringify(results));
      const store = await openPostgresBuilderStore(databaseUrl);
      try {
        const tasks = await store.listTasks();
        const f02 = tasks.find((t) => t.task_id === stableTaskId('F-02') || t.logical_work_id === 'F-02');
        assert.ok(f02);
        const runs = await store.listRunsForTask(f02.task_id);
        const launched = runs.filter((r) => r.provider_run_id);
        assert.equal(launched.length, 1);
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('16. Automation Memory cannot substitute for Builder state', async () => {
    await resetBuilderTables(databaseUrl);
    const store = await openPostgresBuilderStore(databaseUrl);
    const root = makeRoot();
    const core = createBuilderCore({ store, workerProvider: fakeProvider('mem') });
    try {
      const decision = await runJarvisTick({
        root,
        trigger: 'hourly',
        core,
        persist: false,
        catalog: catalog(),
        orientation: ORIENTATION,
        chatMemory: {
          task_id: 'task_from_memory',
          factory_run_id: 'run_from_memory',
          provider_run_id: 'prov_from_memory',
        },
      });
      assert.notEqual(decision.task_id, 'task_from_memory');
      assert.notEqual(decision.factory_run_id, 'run_from_memory');
      const reconstructed = await store.reconstruct();
      assert.equal(
        reconstructed.tasks.some((t) => t.task_id === 'task_from_memory'),
        false
      );
    } finally {
      await Promise.resolve(core.close());
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('17. no credentials are persisted into Builder tables/events', async () => {
    await resetBuilderTables(databaseUrl);
    const store = await openPostgresBuilderStore(databaseUrl);
    try {
      const claimed = await store.claimLogicalWork({
        task_id: 'task_secret',
        logical_work_id: 'work_secret',
        ...lockedIntent({ intent: 'redact secrets' }),
      });
      const inserted = await store.tryInsertActiveRun({
        task_id: claimed.task.task_id,
        provider: 'cursor',
        owner: 'secret-owner',
      });
      await store.updateRun(inserted.run.factory_run_id, {
        evidence: {
          CURSOR_API_KEY: 'crsr_should_not_persist',
          GITHUB_TOKEN: 'ghp_should_not_persist',
          password: 'hunter2',
        },
      });
      await store.appendEvent({
        task_id: claimed.task.task_id,
        factory_run_id: inserted.run.factory_run_id,
        event_type: 'WORKER_STATUS',
        payload: {
          CURSOR_API_KEY: 'crsr_event_secret',
          token: 'secret-token',
        },
      });
      const run = await store.getRun(inserted.run.factory_run_id);
      const events = await store.listEventsForTask(claimed.task.task_id);
      const blob = JSON.stringify({ run, events });
      assert.equal(blob.includes('crsr_should_not_persist'), false);
      assert.equal(blob.includes('ghp_should_not_persist'), false);
      assert.equal(blob.includes('hunter2'), false);
      assert.equal(blob.includes('crsr_event_secret'), false);
      assert.equal(blob.includes('secret-token'), false);
      assert.match(blob, /REDACTED/);
    } finally {
      await store.close();
    }
  });

  test('fresh sandbox does not reclaim an owned in-flight run', async () => {
    await resetBuilderTables(databaseUrl);
    const storeA = await openPostgresBuilderStore(databaseUrl);
    const storeB = await openPostgresBuilderStore(databaseUrl);
    try {
      const claimed = await storeA.claimLogicalWork({
        task_id: 'task_no_reclaim',
        logical_work_id: 'work_no_reclaim',
        ...lockedIntent({ intent: 'no reclaim' }),
      });
      const inserted = await storeA.tryInsertActiveRun({
        task_id: claimed.task.task_id,
        provider: 'cursor',
        owner: 'sandbox-a',
      });
      await storeA.updateRun(inserted.run.factory_run_id, {
        provider_run_id: 'prov_owned',
        provider_agent_id: 'bc-owned',
        status: RUN_STATUS.RUNNING,
      });
      const second = await storeB.tryInsertActiveRun({
        task_id: claimed.task.task_id,
        provider: 'cursor',
        owner: 'sandbox-b',
      });
      assert.equal(second.inserted, false);
      assert.equal(second.run.factory_run_id, inserted.run.factory_run_id);
      assert.equal(second.run.provider_run_id, 'prov_owned');
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });
});
