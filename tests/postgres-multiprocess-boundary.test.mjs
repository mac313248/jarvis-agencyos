// tests/postgres-multiprocess-boundary.test.mjs
// V1.0A + SOT 04 live verification: real multi-process PostgreSQL boundary proof.
// Separate Node child processes hold separate pg connections to one server.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRealPostgresServer } from './support/postgres-real-server.mjs';
import { createDb } from '../src/db/index.js';
import { seedTwoTenants } from './_helpers.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const workerPath = fileURLToPath(new URL('./support/postgres-boundary-worker.mjs', import.meta.url));

const PROTECTED_TABLES = [
  'tenants',
  'users',
  'memberships',
  'authority_grants',
  'action_proposals',
  'approval_decisions',
  'canonical_events',
  'execution_receipts',
  'pii_subjects',
];

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

async function runWorkerJson(mode, payload) {
  return JSON.parse(await runWorker(mode, payload));
}

before(async () => {
  server = await startRealPostgresServer();
  databaseUrl = server.databaseUrl;
  const db = await createDb({ databaseUrl });
  await seedTwoTenants(db);
  await db.close();
});

after(async () => {
  if (server) await server.stop();
});

describe('V1.0A real multi-process PostgreSQL boundary', () => {
  test('tenant A and tenant B see isolated rows from separate processes', async () => {
    const [aCount, bCount] = await Promise.all([
      runWorker('tenant_user_count', { databaseUrl, tenantId: A }),
      runWorker('tenant_user_count', { databaseUrl, tenantId: B }),
    ]);
    assert.equal(aCount, '1');
    assert.equal(bCount, '1');
  });

  test('cross-tenant reads remain blocked across processes', async () => {
    const tenants = await runWorker('cross_tenant_read_blocked', {
      databaseUrl,
      tenantId: A,
    });
    assert.deepEqual(JSON.parse(tenants), [A]);
  });

  test('missing tenant context fails closed in a separate process', async () => {
    const count = await runWorker('missing_context_fails_closed', { databaseUrl });
    assert.equal(count, '0');
  });

  test('concurrent processes cannot widen tenant visibility', async () => {
    const results = await Promise.all([
      runWorker('cross_tenant_read_blocked', { databaseUrl, tenantId: A }),
      runWorker('cross_tenant_read_blocked', { databaseUrl, tenantId: B }),
    ]);
    assert.deepEqual(JSON.parse(results[0]), [A]);
    assert.deepEqual(JSON.parse(results[1]), [B]);
  });
});

describe('SOT 04 Postgres / tenant boundary — real PostgreSQL attack battery', () => {
  test('runtime role is not superuser and lacks BYPASSRLS', async () => {
    const posture = await runWorkerJson('role_posture', { databaseUrl });
    assert.equal(posture.rolsuper, false);
    assert.equal(posture.rolbypassrls, false);
    assert.equal(posture.runtime_owns_protected_table, false);
    for (const row of posture.table_owners) {
      assert.notEqual(row.owner, 'app_runtime', `${row.relname} must not be owned by app_runtime`);
    }
  });

  test('protected tables enforce RLS + FORCE RLS on real PostgreSQL', async () => {
    const flags = await runWorkerJson('force_rls_flags', { databaseUrl });
    assert.equal(flags.length, PROTECTED_TABLES.length);
    for (const row of flags) {
      assert.equal(row.rls, true, `${row.relname} RLS`);
      assert.equal(row.force_rls, true, `${row.relname} FORCE RLS`);
    }
  });

  test('pooled connection cannot leak transaction-local tenant context after commit', async () => {
    const leak = await runWorkerJson('pool_leak_after_commit', { databaseUrl, tenantId: A });
    assert.equal(leak.in_txn_count, 1);
    assert.equal(leak.post_commit_count, 0);
    assert.deepEqual(leak.tenant_b_visible, [B]);
  });

  test('invalid tenant context fails closed (no rows visible)', async () => {
    const closed = await runWorkerJson('invalid_tenant_fails_closed', { databaseUrl });
    assert.equal(closed.users, 0);
    assert.equal(closed.tenants, 0);
  });

  test('cross-tenant INSERT is rejected under real PostgreSQL RLS', async () => {
    const insert = await runWorkerJson('cross_tenant_insert_blocked', { databaseUrl });
    assert.equal(insert.blocked, true);
    assert.match(insert.error || '', /row-level security|new row violates/i);
  });

  test('cross-tenant FK/reference is rejected under real PostgreSQL', async () => {
    const fk = await runWorkerJson('cross_tenant_fk_blocked', { databaseUrl });
    assert.equal(fk.blocked, true);
    assert.match(fk.error || '', /foreign key|violates/i);
  });

  test('runtime role cannot escalate privileges (CREATE ROLE / DISABLE RLS / DROP)', async () => {
    const escalation = await runWorkerJson('privilege_escalation_blocked', { databaseUrl });
    assert.equal(escalation.create_role.blocked, true);
    assert.equal(escalation.disable_rls.blocked, true);
    assert.equal(escalation.drop_table.blocked, true);
  });

  test('authority_control is hidden without trusted tenant context', async () => {
    const auth = await runWorkerJson('authority_no_context_fails_closed', { databaseUrl });
    assert.equal(auth.count, 0);
  });

  test('concurrent attack workers remain isolated under load', async () => {
    const results = await Promise.all([
      runWorkerJson('cross_tenant_insert_blocked', { databaseUrl }),
      runWorkerJson('cross_tenant_fk_blocked', { databaseUrl }),
      runWorker('tenant_user_count', { databaseUrl, tenantId: A }),
      runWorker('tenant_user_count', { databaseUrl, tenantId: B }),
    ]);
    assert.equal(results[0].blocked, true);
    assert.equal(results[1].blocked, true);
    assert.equal(results[2], '1');
    assert.equal(results[3], '1');
  });
});
