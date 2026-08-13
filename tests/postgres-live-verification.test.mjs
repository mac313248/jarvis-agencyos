// tests/postgres-live-verification.test.mjs
// Live verification for 04_LIVE_VERIFICATION_BACKLOG.md#Postgres--tenant-boundary.
// Runs the RLS/FORCE RLS attack battery and authority fail-closed checks against
// a real embedded-postgres server with separate Node child processes per connection.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { startRealPostgresServer } from './support/postgres-real-server.mjs';
import { createDb } from '../src/db/index.js';
import { seedTwoTenants } from './_helpers.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const workerPath = fileURLToPath(new URL('./support/postgres-boundary-worker.mjs', import.meta.url));
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

let server;
let databaseUrl;

function runWorker(mode, payload) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [mode, JSON.stringify(payload)], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_OPTIONS: '' },
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

before(async () => {
  server = await startRealPostgresServer();
  databaseUrl = server.databaseUrl;
  const db = await createDb({ databaseUrl });
  await seedTwoTenants(db);
  await db.query(
    `INSERT INTO authority_control (tenant_id, active_authority, revocation_epoch, kill_epoch)
     VALUES ($1, true, 0, 0), ($2, true, 7, 9)
     ON CONFLICT (tenant_id) DO UPDATE SET
       active_authority = EXCLUDED.active_authority,
       revocation_epoch = EXCLUDED.revocation_epoch,
       kill_epoch = EXCLUDED.kill_epoch;`,
    [A, B]
  );
  await db.close();
});

after(async () => {
  if (server) await server.stop();
});

describe('Postgres / tenant boundary live verification', () => {
  test('reproduce migrations on current main', async () => {
    const db = await createDb({ databaseUrl });
    try {
      const migrationFiles = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
      const applied = await db.query('SELECT id FROM schema_migrations ORDER BY id;');
      assert.equal(applied.rows.length, migrationFiles.length);
      assert.ok(applied.rows.some((row) => row.id === '0001_roles_and_tenant_context'));
      assert.ok(applied.rows.some((row) => row.id === '0021_v1_0c_single_flight'));
    } finally {
      await db.close();
    }
  });

  test('runtime role is not superuser and lacks BYPASSRLS (separate process)', async () => {
    const props = JSON.parse(await runWorker('runtime_role_properties', { databaseUrl }));
    assert.equal(props.rolname, 'app_runtime');
    assert.equal(props.rolsuper, false);
    assert.equal(props.rolbypassrls, false);
  });

  test('protected tables use FORCE RLS and are not owned by app_runtime', async () => {
    const db = await createDb({ databaseUrl });
    try {
      const tables = await db.query(`
        SELECT c.relname, r.rolname AS owner, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.relkind = 'r'
          AND c.relnamespace = 'public'::regnamespace
          AND c.relname IN (
            'tenants', 'users', 'memberships', 'authority_control',
            'action_proposals', 'execution_receipts', 'canonical_events'
          )
        ORDER BY c.relname;
      `);
      assert.ok(tables.rows.length >= 4, 'expected core tenant-owned tables');
      for (const row of tables.rows) {
        assert.notEqual(row.owner, 'app_runtime', `${row.relname} must not be owned by app_runtime`);
        assert.equal(row.relrowsecurity, true, `${row.relname} RLS enabled`);
        assert.equal(row.relforcerowsecurity, true, `${row.relname} FORCE RLS`);
      }
    } finally {
      await db.close();
    }
  });

  test('cross-tenant insert remains blocked across processes', async () => {
    const result = await runWorker('cross_tenant_insert_blocked', {
      databaseUrl,
      tenantId: A,
      otherTenantId: B,
    });
    assert.equal(result, 'blocked');
  });

  test('pooled transaction-local tenant context cannot leak across processes', async () => {
    const count = await runWorker('pool_leak_fails_closed', { databaseUrl, tenantId: A });
    assert.equal(count, '0');
  });

  test('cross-tenant FK/reference is rejected across processes', async () => {
    const result = await runWorker('cross_tenant_fk_blocked', { databaseUrl, tenantId: A });
    assert.equal(result, 'blocked');
  });

  test('runtime role cannot disable RLS in a separate process', async () => {
    const result = await runWorker('disable_rls_blocked', { databaseUrl });
    assert.notEqual(result, 'leaked');
    assert.match(result, /permission denied|must be owner/i);
  });

  test('authority reader fails closed without tenant context across processes', async () => {
    const result = JSON.parse(await runWorker('authority_no_context_fails_closed', { databaseUrl }));
    assert.equal(result.rows, 0);
  });

  test('authority reader is bound to trusted tenant context across processes', async () => {
    const state = JSON.parse(await runWorker('authority_tenant_bound', { databaseUrl, tenantId: A }));
    assert.equal(state.active_authority, true);
    assert.equal(state.revocation_epoch, 0);
    assert.equal(state.kill_epoch, 0);
    assert.notEqual(state.revocation_epoch, 7);
    assert.notEqual(state.kill_epoch, 9);
  });

  test('concurrent tenant contexts remain isolated across processes', async () => {
    const results = await Promise.all([
      runWorker('cross_tenant_read_blocked', { databaseUrl, tenantId: A }),
      runWorker('cross_tenant_read_blocked', { databaseUrl, tenantId: B }),
      runWorker('tenant_user_count', { databaseUrl, tenantId: A }),
      runWorker('tenant_user_count', { databaseUrl, tenantId: B }),
    ]);
    assert.deepEqual(JSON.parse(results[0]), [A]);
    assert.deepEqual(JSON.parse(results[1]), [B]);
    assert.equal(results[2], '1');
    assert.equal(results[3], '1');
  });
});
