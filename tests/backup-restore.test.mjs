// tests/backup-restore.test.mjs
// F-13 Backup / restore rehearsal acceptance:
//   #53 backup restore is actually rehearsed
//
// SOT: 10_OBSERVABILITY_RECOVERY.md (Backups + PITR sequence)
//      12_ACCEPTANCE_AND_IMPLEMENTATION.md#Recovery
//
// Stop condition: unrehearsed restore.
// Business-write autonomy remains DISABLED.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import {
  BUSINESS_WRITE_AUTONOMY,
  LIVE_EXTERNAL_SIDE_EFFECTS,
  BACKUP_RESTORE_REHEARSAL,
  assertBusinessWriteAutonomyDisabled,
} from '../src/runtime/autonomy.js';
import {
  REQUIRED_BACKUP_SURFACES,
  BackupRestoreError,
  assertRestoreRehearsed,
  createBackupRestoreRuntime,
} from '../src/runtime/backup-restore.js';
import { WritersFrozenError } from '../src/runtime/dbos.js';

let db;
let harnessReady = false;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

before(async () => {
  db = await freshCluster({ unique: 'backup-restore-test' });
  await seedTwoTenants(db, { aId: A, bId: B });
  harnessReady = true;
});

after(async () => {
  if (db) await db.close();
});

function runtimeFor(tenantId) {
  return createBackupRestoreRuntime(db, {
    trustedTenantId: tenantId,
    gitRemoteUrl: 'git@local:jarvis-agencyos.git',
  });
}

describe('F-13 autonomy + contract surface', () => {
  test('acceptance harness initialized (cancelled suite is not a pass)', () => {
    assert.equal(harnessReady, true);
    assert.ok(db, 'freshCluster must succeed before F-13 acceptance runs');
  });

  test('business-write autonomy remains DISABLED', () => {
    assert.equal(BUSINESS_WRITE_AUTONOMY, false);
    assert.equal(LIVE_EXTERNAL_SIDE_EFFECTS, false);
    assert.equal(BACKUP_RESTORE_REHEARSAL, true);
    assert.equal(assertBusinessWriteAutonomyDisabled(), true);
  });

  test('contract_metadata records BackupRestoreRehearsal v1', async () => {
    const r = await db.query(
      `SELECT contract_name, contract_version, schema_path
         FROM contract_metadata WHERE contract_name='BackupRestoreRehearsal';`
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].contract_version, 1);
    assert.match(r.rows[0].schema_path, /Backups/);
    assert.match(r.rows[0].schema_path, /Recovery/);
  });

  test('required backup surfaces match SOT inventory', () => {
    assert.deepEqual([...REQUIRED_BACKUP_SURFACES].sort(), [
      'derived_indexes',
      'git_remote',
      'object_storage',
      'postgres_pitr',
    ]);
  });
});

describe('F-13 #53 stop condition: unrehearsed restore', () => {
  test('assertRestoreRehearsed fails closed before any successful rehearsal', async () => {
    await assert.rejects(
      () => assertRestoreRehearsed(db),
      (err) => err instanceof BackupRestoreError && err.code === 'UNREHEARSED_RESTORE'
    );
  });

  test('createBackupRestoreRuntime requires trusted tenant (fail-closed)', () => {
    assert.throws(
      () => createBackupRestoreRuntime(db, {}),
      (err) => err instanceof BackupRestoreError && err.code === 'MISSING_TENANT_CONTEXT'
    );
  });
});

describe('F-13 #53 backup restore is actually rehearsed', () => {
  test('wipe+restore+reconcile proves backup; unrehearsed gate then passes', async () => {
    const runtime = runtimeFor(A);
    const fixture = await runtime.seedDurableFixture({
      stateKey: 'backup.rehearsal.marker',
      value: { marker: 'pre-backup-value', n: 53 },
    });

    const backup = await runtime.createBackupSet({ label: 'f13-acceptance' });
    assert.equal(backup.artifacts.length, REQUIRED_BACKUP_SURFACES.length);
    assert.deepEqual(
      backup.artifacts.map((a) => a.surface).sort(),
      [...REQUIRED_BACKUP_SURFACES].sort()
    );

    // Confirm fixture visible before rehearsal.
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const r = await tx.query(
        `SELECT value->>'marker' AS marker FROM current_state_records
          WHERE state_key = $1;`,
        [fixture.stateKey]
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].marker, 'pre-backup-value');
    });

    const result = await runtime.runRestoreRehearsal({ backupEpoch: backup.backup_epoch });
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.postgres_restored, true);
    assert.equal(result.derived_indexes_rebuilt, true);
    assert.equal(result.dbos_reconciled, true);
    assert.equal(result.providers_reconciled, true);
    assert.equal(result.writers_reactivated, true);
    assert.ok(result.pre_restore_fingerprint);
    assert.equal(result.pre_restore_fingerprint, result.post_restore_fingerprint);
    assert.ok(result.recovery_epoch >= 1);
    assert.ok(result.completed_at);

    // Durable state restored after actual wipe+restore.
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const state = await tx.query(
        `SELECT state_id::text, value->>'marker' AS marker, value->>'n' AS n
           FROM current_state_records WHERE state_key = $1;`,
        [fixture.stateKey]
      );
      assert.equal(state.rows.length, 1);
      assert.equal(state.rows[0].state_id, fixture.stateId);
      assert.equal(state.rows[0].marker, 'pre-backup-value');
      assert.equal(state.rows[0].n, '53');

      const events = await tx.query(
        `SELECT event_id::text FROM canonical_events WHERE dedupe_key = $1;`,
        [fixture.dedupe]
      );
      assert.equal(events.rows.length, 1);
      assert.equal(events.rows[0].event_id, fixture.eventId);

      const indexes = await tx.query(
        `SELECT index_kind FROM derived_index_entries
          WHERE source_key = $1 ORDER BY index_kind;`,
        [`backup-epoch-${backup.backup_epoch}`]
      );
      assert.deepEqual(
        indexes.rows.map((r) => r.index_kind),
        ['fts', 'pgvector']
      );
    });

    // Writers re-enabled after full reconcile.
    await runtime.dbos.assertWritersAllowed();

    // Stop condition cleared only by SUCCESS proof.
    const proof = await assertRestoreRehearsed(db, { backupEpoch: backup.backup_epoch });
    assert.equal(proof.rehearsal_id, result.rehearsal_id);
    assert.equal(proof.status, 'SUCCESS');
  });

  test('rehearsal freezes writers mid-restore and refuses premature thaw', async () => {
    const runtime = runtimeFor(A);
    await runtime.seedDurableFixture({
      stateKey: 'backup.freeze.check',
      value: { marker: 'freeze' },
    });
    const backup = await runtime.createBackupSet({ label: 'freeze-check' });

    // Direct beginRestore path still enforces #52 during F-13.
    const frozen = await runtime.dbos.beginRestore();
    assert.equal(frozen.writers_frozen, true);
    await assert.rejects(
      () => runtime.dbos.assertWritersAllowed(),
      (err) => err instanceof WritersFrozenError
    );
    await assert.rejects(
      () => runtime.dbos.completeRestore(),
      (err) => err.code === 'RECONCILE_INCOMPLETE'
    );
    await runtime.dbos.markReconciled('postgres');
    await runtime.dbos.markReconciled('dbos');
    await runtime.dbos.markReconciled('providers');
    const open = await runtime.dbos.completeRestore();
    assert.equal(open.writers_frozen, false);

    // Full rehearsal still works after the manual freeze/thaw probe.
    const result = await runtime.runRestoreRehearsal({ backupEpoch: backup.backup_epoch });
    assert.equal(result.status, 'SUCCESS');
  });

  test('incomplete backup surfaces refuse rehearsal (fail-closed)', async () => {
    const runtime = runtimeFor(A);
    await runtime.seedDurableFixture({ stateKey: 'backup.incomplete' });
    const backup = await runtime.createBackupSet({ label: 'will-break' });

    // Sabotage: remove one required surface artifact for this epoch.
    await db.query(
      `DELETE FROM backup_artifacts
        WHERE backup_epoch = $1 AND surface = 'git_remote';`,
      [backup.backup_epoch]
    );

    await assert.rejects(
      () => runtime.runRestoreRehearsal({ backupEpoch: backup.backup_epoch }),
      (err) => err instanceof BackupRestoreError
        && err.code === 'BACKUP_SURFACES_INCOMPLETE'
        && err.details.missing.includes('git_remote')
    );
  });

  test('tenant B durable rows stay isolated during tenant A rehearsal', async () => {
    const runtimeA = runtimeFor(A);
    const runtimeB = runtimeFor(B);

    await asRuntimeTenant(db, 'app_runtime', B, async (tx) => {
      await tx.query(
        `INSERT INTO current_state_records
           (state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
            source_system, max_age_seconds, freshness)
         VALUES ('bbbbbbbb-0000-4000-8000-0000000000bb'::uuid, cur_tenant(),
                 'backup.tenant-b', 'recovery', 'b',
                 '{"marker":"tenant-b-only"}'::jsonb, '1', 'backup_restore', 3600, 'FRESH');`
      );
    });

    await runtimeA.seedDurableFixture({ stateKey: 'backup.tenant-a' });
    const backup = await runtimeA.createBackupSet({ label: 'tenant-a' });
    await runtimeA.runRestoreRehearsal({ backupEpoch: backup.backup_epoch });

    await asRuntimeTenant(db, 'app_runtime', B, async (tx) => {
      const r = await tx.query(
        `SELECT value->>'marker' AS marker FROM current_state_records
          WHERE state_key = 'backup.tenant-b';`
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].marker, 'tenant-b-only');
    });

    // B never got a SUCCESS rehearsal of its own epoch — gate still fails for B-only claim
    // when asking with a nonexistent epoch.
    await assert.rejects(
      () => runtimeB.assertRestoreRehearsed({ backupEpoch: 999999 }),
      (err) => err instanceof BackupRestoreError && err.code === 'UNREHEARSED_RESTORE'
    );
  });
});
