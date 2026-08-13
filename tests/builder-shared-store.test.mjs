// Shared durable Builder store — control-plane persistence.
// Proves PostgreSQL is the production authority, SQLite is local/test only,
// and a fresh agent reconstructs identical state from the shared store.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import {
  BUILDER_ALLOW_SQLITE_ENV,
  BUILDER_DATABASE_URL_ENV,
  BUILDER_SCHEMA_VERSION,
  BUILDER_SQLITE_PATH_ENV,
  BuilderStoreError,
  REVIEW_STATUS,
  RUN_STATUS,
  STORE_KIND,
  TASK_STATUS,
  VERIFICATION_RESULT,
  createBuilderCore,
  createBuilderCoreAsync,
  isSensitiveKey,
  openBuilderStore,
  openAuthoritativeBuilderStore,
  redactConnectionString,
  redactSecrets,
  resolveBuilderStoreTarget,
} from '../src/builder/index.js';
import { startBuilderPostgres } from './support/builder-postgres.mjs';

const agentPath = fileURLToPath(new URL('./support/builder-store-agent.mjs', import.meta.url));
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECRET_PASS = 'ctrl_SECRET_never_leak_xyz';

function assertNoSecret(value) {
  const text = typeof value === 'string' ? value : inspect(value, { depth: 8 });
  assert.equal(text.includes(SECRET_PASS), false, `secret leaked: ${text.slice(0, 240)}`);
  assert.equal(
    /postgresql:\/\/[^:]+:[^@]+@/i.test(text) && text.includes(SECRET_PASS),
    false
  );
}

function runAgent(mode, { databaseUrl, extraArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(agentPath, [mode, '--database-url', databaseUrl, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: mkdtempSync(join(tmpdir(), 'builder-agent-')),
      env: {
        ...process.env,
        [BUILDER_DATABASE_URL_ENV]: databaseUrl,
        [BUILDER_ALLOW_SQLITE_ENV]: '',
        [BUILDER_SQLITE_PATH_ENV]: '',
        NODE_OPTIONS: '',
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(out.trim().split('\n').at(-1)));
        } catch (parseErr) {
          reject(new Error(`agent ${mode} bad json: ${out}\n${err}\n${parseErr}`));
        }
      } else {
        reject(new Error(`agent ${mode} failed (${code}): ${err || out}`));
      }
    });
  });
}

describe('Builder store target resolution', () => {
  it('uses the Builder control-plane database URL and never AgencyOS DATABASE_URL', () => {
    const target = resolveBuilderStoreTarget({
      env: {
        [BUILDER_DATABASE_URL_ENV]: `postgresql://builder:${SECRET_PASS}@127.0.0.1:5432/builder`,
        DATABASE_URL: `postgresql://agency:${SECRET_PASS}@127.0.0.1:5432/agencyos`,
      },
    });
    assert.equal(target.kind, STORE_KIND.POSTGRES);
    assert.equal(target.sqlite_fallback_disabled, true);
    assertNoSecret(redactConnectionString(target.databaseUrl));
    assert.equal(isSensitiveKey(BUILDER_DATABASE_URL_ENV), true);
    assert.equal(isSensitiveKey('DATABASE_URL'), true);
  });

  it('fails closed in production without the shared store', () => {
    assert.throws(
      () =>
        resolveBuilderStoreTarget({
          env: { NODE_ENV: 'production' },
        }),
      (err) =>
        err instanceof BuilderStoreError && err.code === 'SHARED_STORE_UNAVAILABLE'
    );
    assert.throws(
      () =>
        resolveBuilderStoreTarget({
          storeKind: 'postgres',
          env: { DATABASE_URL: `postgresql://agency:${SECRET_PASS}@127.0.0.1:5432/agencyos` },
        }),
      (err) =>
        err instanceof BuilderStoreError &&
        err.code === 'SHARED_STORE_UNAVAILABLE' &&
        !String(err.message).includes(SECRET_PASS)
    );
  });

  it('keeps SQLite only when explicitly allowed', () => {
    const memory = resolveBuilderStoreTarget({
      dbPath: ':memory:',
      allowSqlite: true,
      env: { NODE_ENV: 'test' },
    });
    assert.equal(memory.kind, STORE_KIND.SQLITE);
    const denied = () =>
      resolveBuilderStoreTarget({
        env: { JARVIS_CONTROL_PLANE: 'cloud' },
      });
    assert.throws(denied, /refusing local SQLite fallback|Builder control-plane database URL|ALLOW_SQLITE/);
  });
});

describe('SQLite local fallback still reconstructs', () => {
  it('persists leases, rejects duplicate claims, and fences stale runs', () => {
    const store = openBuilderStore(':memory:');
    const core = createBuilderCore({ store });
    const task = core.createAndLockTask({
      intent: 'sqlite fallback',
      acceptance_ref: 'tests/builder-shared-store.test.mjs',
      allowed_paths: ['src/builder/'],
      tool_manifest: { providers: ['cursor'], tools: ['repo_read'], mode: 'build' },
    });
    assert.equal(store.kind, STORE_KIND.SQLITE);
    assert.equal(core.reconstruct().schema_version, BUILDER_SCHEMA_VERSION);
    assert.throws(
      () =>
        store.insertTask({
          task_id: task.task_id,
          intent: 'dup',
          intent_version: 1,
          acceptance_ref: 'a',
          allowed_paths: ['src/'],
          tool_manifest: { providers: [], tools: [], mode: 'build' },
          review_required: true,
          status: TASK_STATUS.DRAFT,
        }),
      (err) => err.code === 'DUPLICATE_CLAIM'
    );
    const run = core.createRun({
      task_id: task.task_id,
      provider: 'cursor',
      provider_run_id: 'sqlite-run',
    });
    core.markRunStale(run.factory_run_id);
    assert.throws(
      () => store.updateRun(run.factory_run_id, { status: RUN_STATUS.RUNNING }),
      (err) => err.code === 'STALE_RUN'
    );
    const lease1 = store.tryAcquireLease('jarvis-tick', 'a');
    const lease2 = store.tryAcquireLease('jarvis-tick', 'b');
    assert.ok(lease1);
    assert.equal(lease2, null);
    store.releaseLease('jarvis-tick', 'a');
    core.close();
  });
});

describe('Shared PostgreSQL Builder store', () => {
  let server;
  let databaseUrl;

  before(async () => {
    server = await startBuilderPostgres();
    databaseUrl = server.databaseUrl;
  });

  after(async () => {
    if (server) await server.stop();
  });

  it('Agent B reconstructs Agent A state from a fresh VM with no local SQLite', async () => {
    const agentA = await runAgent('persist', { databaseUrl });
    assert.equal(agentA.store_backend, STORE_KIND.POSTGRES);
    assert.equal(agentA.task_id, 'task_shared_store_cross_agent');
    assert.equal(agentA.commit_sha, SHA);
    assert.equal(agentA.verification_result, VERIFICATION_RESULT.PASS);
    assert.equal(agentA.review_status, REVIEW_STATUS.PASS);
    assert.equal(agentA.local_sqlite_present, false);
    assert.equal(agentA.task_count, 1);

    const agentB = await runAgent('reconstruct', { databaseUrl });
    assert.equal(agentB.store_backend, STORE_KIND.POSTGRES);
    assert.equal(agentB.official_reconstruct_delegated_to, 'BUILDER_CORE');
    assert.equal(agentB.task_id, agentA.task_id);
    assert.equal(agentB.factory_run_id, agentA.factory_run_id);
    assert.equal(agentB.candidate_id, agentA.candidate_id);
    assert.equal(agentB.commit_sha, agentA.commit_sha);
    assert.equal(agentB.verification_id, agentA.verification_id);
    assert.equal(agentB.review_id, agentA.review_id);
    assert.equal(agentB.handoff_factory_run_id, agentA.factory_run_id);
    assert.equal(agentB.duplicate_task_created, false);
    assert.equal(agentB.task_count, 1);
    assert.equal(agentB.local_sqlite_present, false);
    assert.deepEqual(agentB.official_nonterminal_ids, [agentA.task_id]);
  });

  it('rejects concurrent duplicate claims', async () => {
    const first = await runAgent('duplicate-claim', { databaseUrl });
    assert.equal(first.duplicate_rejected, true);
    assert.equal(first.task_count, 1);
    const [a, b] = await Promise.all([
      runAgent('duplicate-claim', { databaseUrl }),
      runAgent('duplicate-claim', { databaseUrl }),
    ]);
    assert.equal(a.duplicate_rejected && b.duplicate_rejected, true);
    const reconstructed = await runAgent('reconstruct', { databaseUrl });
    assert.equal(reconstructed.task_count, 1);
  });

  it('rejects concurrent durable tick leases', async () => {
    const coreA = await createBuilderCoreAsync({ databaseUrl });
    const coreB = await createBuilderCoreAsync({ databaseUrl });
    try {
      const first = coreA.store.tryAcquireLease('jarvis-tick', 'agent-a');
      const second = coreB.store.tryAcquireLease('jarvis-tick', 'agent-b');
      assert.ok(first);
      assert.equal(second, null);
      coreA.store.releaseLease('jarvis-tick', 'agent-a');
      const stolen = coreB.store.tryAcquireLease('jarvis-tick', 'agent-b');
      assert.ok(stolen);
    } finally {
      coreA.close();
      coreB.close();
    }
  });

  it('fences stale runs so they cannot regain authority', async () => {
    const result = await runAgent('stale-fence', { databaseUrl });
    assert.equal(result.run_status, RUN_STATUS.STALE);
    assert.equal(result.stale_update_rejected, true);
    assert.equal(result.stale_apply_rejected, true);
    assert.equal(result.current_factory_run_id, null);
  });

  it('keeps exact SHA, provider, review, and verification records across agents', async () => {
    const core = await createBuilderCoreAsync({ databaseUrl });
    try {
      const rec = core.reconstruct();
      const task = rec.nonterminal_tasks[0];
      const candidate = rec.candidates[0];
      assert.equal(candidate.commit_sha, SHA);
      assert.match(candidate.commit_sha, /^[0-9a-f]{40}$/);
      const verification = core.store.getVerification(candidate.verification_ref);
      const review = core.store.getReview(candidate.review_ref);
      assert.equal(verification.commit_sha, SHA);
      assert.equal(review.commit_sha, SHA);
      const run = rec.runs[0];
      assert.equal(run.provider, 'cursor');
      assert.equal(run.provider_run_id, 'prov_shared_store_1');
      assert.equal(verification.result, VERIFICATION_RESULT.PASS);
      assert.equal(review.review_status, REVIEW_STATUS.PASS);
      assert.equal(task.status, TASK_STATUS.LOCKED);
    } finally {
      core.close();
    }
  });

  it('never emits secret values from store errors or reconstruct', async () => {
    const badUrl = `postgresql://builder:${SECRET_PASS}@127.0.0.1:1/builder`;
    await assert.rejects(
      () => openAuthoritativeBuilderStore({ databaseUrl: badUrl }),
      (err) => {
        assert.equal(err.code, 'SHARED_STORE_UNAVAILABLE');
        assertNoSecret(err);
        assertNoSecret(err.message);
        assertNoSecret(inspect(err));
        assertNoSecret(JSON.stringify(redactSecrets(err)));
        return true;
      }
    );
    const core = await createBuilderCoreAsync({ databaseUrl });
    try {
      const rec = core.reconstruct();
      assertNoSecret(rec);
      assertNoSecret(JSON.stringify(rec));
      assert.equal(
        redactSecrets({ [BUILDER_DATABASE_URL_ENV]: badUrl })[BUILDER_DATABASE_URL_ENV],
        '[REDACTED]'
      );
    } finally {
      core.close();
    }
  });

  it('fails closed rather than opening a fresh local SQLite database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'builder-fail-closed-'));
    try {
      await assert.rejects(
        () =>
          openAuthoritativeBuilderStore({
            env: {
              NODE_ENV: 'production',
              [BUILDER_DATABASE_URL_ENV]: `postgresql://builder:${SECRET_PASS}@127.0.0.1:1/builder`,
            },
          }),
        (err) => err.code === 'SHARED_STORE_UNAVAILABLE'
      );
      await assert.rejects(
        () =>
          openAuthoritativeBuilderStore({
            dbPath: join(dir, 'jarvis-tasks.sqlite'),
            env: { JARVIS_CONTROL_PLANE: 'cloud' },
          }),
        (err) => err.code === 'SHARED_STORE_UNAVAILABLE'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
