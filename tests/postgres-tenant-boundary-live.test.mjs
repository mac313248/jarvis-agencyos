// tests/postgres-tenant-boundary-live.test.mjs
// Live verification for 04_LIVE_VERIFICATION_BACKLOG.md#Postgres--tenant-boundary.
// Runs the RLS attack battery, role checks, pooled-context leak tests,
// cross-tenant FK rejection, authority outage fail-closed, and backup restore
// rehearsal against a real multi-process PostgreSQL server (embedded-postgres).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRealPostgresServer } from './support/postgres-real-server.mjs';
import {
  TENANT_A,
  TENANT_B,
  TENANT_C,
  runPostgresWorker,
  parseWorkerJson,
} from './support/postgres-live-harness.mjs';
import { createDb } from '../src/db/index.js';
import { seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import {
  createBackupRestoreRuntime,
} from '../src/runtime/backup-restore.js';

const PROTECTED_TABLES = [
  'tenants',
  'users',
  'memberships',
  'authority_grants',
  'authority_control',
  'action_proposals',
  'approval_decisions',
  'canonical_events',
  'execution_receipts',
  'pii_subjects',
];

let server;
let databaseUrl;
let db;

before(async () => {
  server = await startRealPostgresServer();
  databaseUrl = server.databaseUrl;
  db = await createDb({ databaseUrl });
  await seedTwoTenants(db, { aId: TENANT_A, bId: TENANT_B });
  await asRuntimeTenant(db, 'app_runtime', TENANT_A, async (tx) => {
    await tx.query(
      `INSERT INTO authority_control (tenant_id, active_authority, revocation_epoch, kill_epoch)
       VALUES ($1, true, 0, 0);`,
      [TENANT_A]
    );
  });
  await asRuntimeTenant(db, 'app_runtime', TENANT_B, async (tx) => {
    await tx.query(
      `INSERT INTO authority_control (tenant_id, active_authority, revocation_epoch, kill_epoch)
       VALUES ($1, true, 7, 9);`,
      [TENANT_B]
    );
  });
});

after(async () => {
  if (db) await db.close();
  if (server) await server.stop();
});

describe('Postgres / tenant boundary live verification', () => {
  test('migrations reproduce on current main (real PostgreSQL server)', async () => {
    const applied = (await db.query(
      `SELECT count(*)::int AS n FROM schema_migrations;`
    )).rows[0].n;
    assert.ok(applied > 0, 'migrations must apply on real PostgreSQL');
    const setTenant = (await db.query(
      `SELECT proname FROM pg_proc WHERE proname = 'set_tenant';`
    )).rows;
    assert.equal(setTenant.length, 1, 'set_tenant() must exist after migrate');
  });

  test('runtime role has no BYPASSRLS and is not superuser (real PostgreSQL)', async () => {
    const raw = await runPostgresWorker('role_introspection', {
      databaseUrl,
      role: 'postgres',
      tables: PROTECTED_TABLES,
    });
    const info = parseWorkerJson(raw);
    const runtime = info.roles.find((row) => row.rolname === 'app_runtime');
    assert.ok(runtime, 'app_runtime role must exist');
    assert.equal(runtime.rolsuper, false);
    assert.equal(runtime.rolbypassrls, false);
  });

  test('protected tables use FORCE RLS and are not owned by app_runtime', async () => {
    const raw = await runPostgresWorker('role_introspection', {
      databaseUrl,
      role: 'postgres',
      tables: PROTECTED_TABLES,
    });
    const info = parseWorkerJson(raw);
    for (const table of PROTECTED_TABLES) {
      const row = info.tables.find((entry) => entry.relname === table);
      assert.ok(row, `${table} must exist`);
      assert.equal(row.relrowsecurity, true, `${table} RLS`);
      assert.equal(row.relforcerowsecurity, true, `${table} FORCE RLS`);
      assert.notEqual(row.owner, 'app_runtime', `${table} must not be owned by app_runtime`);
    }
  });

  test('RLS attack battery: cross-tenant read blocked across processes', async () => {
    const raw = await runPostgresWorker('cross_tenant_read_blocked', {
      databaseUrl,
      tenantId: TENANT_A,
    });
    assert.deepEqual(parseWorkerJson(raw), [TENANT_A]);
  });

  test('RLS attack battery: cross-tenant insert blocked across processes', async () => {
    const raw = await runPostgresWorker('rls_insert_cross_tenant', {
      databaseUrl,
      tenantId: TENANT_A,
      otherTenantId: TENANT_B,
    });
    assert.equal(parseWorkerJson(raw).passed, true);
  });

  test('RLS attack battery: cross-tenant update blocked across processes', async () => {
    const raw = await runPostgresWorker('rls_update_cross_tenant', {
      databaseUrl,
      tenantId: TENANT_A,
      otherTenantId: TENANT_B,
    });
    assert.equal(parseWorkerJson(raw).passed, true);
  });

  test('RLS attack battery: cross-tenant delete blocked across processes', async () => {
    const raw = await runPostgresWorker('rls_delete_cross_tenant', {
      databaseUrl,
      tenantId: TENANT_A,
      otherTenantId: TENANT_B,
    });
    assert.equal(parseWorkerJson(raw).passed, true);
  });

  test('missing tenant context fails closed across processes', async () => {
    const count = await runPostgresWorker('missing_context_fails_closed', { databaseUrl });
    assert.equal(count, '0');
    const insert = parseWorkerJson(await runPostgresWorker('missing_context_insert_blocked', {
      databaseUrl,
      tenantId: TENANT_A,
    }));
    assert.equal(insert.passed, true);
  });

  test('runtime role cannot bypass RLS across processes', async () => {
    const raw = await runPostgresWorker('runtime_cannot_bypass_rls', { databaseUrl });
    assert.equal(parseWorkerJson(raw).passed, true);
  });

  test('pooled transaction-local tenant context cannot leak across processes', async () => {
    const raw = await runPostgresWorker('pool_leak_test', {
      databaseUrl,
      tenantId: TENANT_A,
      otherTenantId: TENANT_B,
    });
    assert.equal(parseWorkerJson(raw).passed, true);
  });

  test('cross-tenant FK/constraint rejected across processes', async () => {
    const raw = await runPostgresWorker('cross_tenant_fk_rejected', {
      databaseUrl,
      tenantId: TENANT_A,
    });
    assert.equal(parseWorkerJson(raw).passed, true);
  });

  test('client-supplied tenant cannot override trusted context across processes', async () => {
    const raw = await runPostgresWorker('client_tenant_override_blocked', {
      databaseUrl,
      tenantId: TENANT_A,
      otherTenantId: TENANT_B,
    });
    assert.equal(parseWorkerJson(raw).passed, true);
  });

  test('authority-store outage fails closed across processes', async () => {
    const raw = await runPostgresWorker('authority_outage_fails_closed', {
      databaseUrl,
      tenantId: TENANT_C,
    });
    assert.equal(parseWorkerJson(raw).passed, true);
  });

  test('first real multi-process PostgreSQL run preserves tenant isolation', async () => {
    const [aCount, bCount] = await Promise.all([
      runPostgresWorker('tenant_user_count', { databaseUrl, tenantId: TENANT_A }),
      runPostgresWorker('tenant_user_count', { databaseUrl, tenantId: TENANT_B }),
    ]);
    assert.equal(aCount, '1');
    assert.equal(bCount, '1');
  });

  test('PITR restore rehearsal succeeds on real PostgreSQL', async () => {
    const runtime = createBackupRestoreRuntime(db, { trustedTenantId: TENANT_A });
    await runtime.seedDurableFixture({
      stateKey: 'live.postgres.pitr',
      value: { marker: 'live-real-postgres' },
    });
    const backup = await runtime.createBackupSet({ label: 'live-postgres-pitr' });
    const result = await runtime.runRestoreRehearsal({ backupEpoch: backup.backup_epoch });
    assert.equal(result.status, 'SUCCESS');
  });

  test('backup restore rehearsal remains tenant-isolated on real PostgreSQL', async () => {
    const runtimeA = createBackupRestoreRuntime(db, { trustedTenantId: TENANT_A });
    const runtimeB = createBackupRestoreRuntime(db, { trustedTenantId: TENANT_B });
    await runtimeA.seedDurableFixture({
      stateKey: 'live.postgres.tenant-a',
      value: { marker: 'tenant-a-live' },
    });
    const backupA = await runtimeA.createBackupSet({ label: 'live-postgres-tenant-a' });
    await assert.rejects(
      () => runtimeB.runRestoreRehearsal({ backupEpoch: backupA.backup_epoch }),
      (err) => err.code === 'BACKUP_NOT_FOUND' || err.code === 'BACKUP_SURFACES_INCOMPLETE'
    );
  });
});
