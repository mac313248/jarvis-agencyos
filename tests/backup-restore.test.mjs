// tests/backup-restore.test.mjs
// F-13 Backup / restore rehearsal acceptance:
//   #53 backup restore is actually rehearsed
//
// SOT: 10_OBSERVABILITY_RECOVERY.md (Backups + PITR sequence)
//      12_ACCEPTANCE_AND_IMPLEMENTATION.md#Recovery
//      01_ARCHITECTURE_LOCKS.md (tenant isolation)
//
// Stop condition: unrehearsed restore.
// Business-write autonomy remains DISABLED.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import {
  BUSINESS_WRITE_AUTONOMY,
  LIVE_EXTERNAL_SIDE_EFFECTS,
  BACKUP_RESTORE_REHEARSAL,
  assertBusinessWriteAutonomyDisabled,
} from '../src/runtime/autonomy.js';
import {
  REQUIRED_BACKUP_SURFACES,
  DEFAULT_GIT_PROVENANCE,
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

function runtimeFor(tenantId, gitOverrides = {}) {
  return createBackupRestoreRuntime(db, {
    trustedTenantId: tenantId,
    ...gitOverrides,
  });
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function fingerprintPayload(payload) {
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
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

  test('backup_artifacts and backup_rehearsal_runs are FORCE RLS tenant-owned', async () => {
    const r = await db.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('backup_artifacts', 'backup_rehearsal_runs',
                            'object_storage_versions', 'derived_index_entries')
        ORDER BY c.relname;`
    );
    assert.equal(r.rows.length, 4);
    for (const row of r.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} RLS`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} FORCE RLS`);
    }
  });
});

describe('F-13 #53 stop condition: unrehearsed restore', () => {
  test('assertRestoreRehearsed requires trusted tenant (fail-closed)', async () => {
    await assert.rejects(
      () => assertRestoreRehearsed(db),
      (err) => err instanceof BackupRestoreError && err.code === 'MISSING_TENANT_CONTEXT'
    );
  });

  test('assertRestoreRehearsed fails closed before any successful rehearsal', async () => {
    await assert.rejects(
      () => assertRestoreRehearsed(db, { trustedTenantId: A }),
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
      typedProperties: { marker: 'event-props', n: 53 },
    });

    const backup = await runtime.createBackupSet({ label: 'f13-acceptance' });
    assert.equal(backup.artifacts.length, REQUIRED_BACKUP_SURFACES.length);
    assert.deepEqual(
      backup.artifacts.map((a) => a.surface).sort(),
      [...REQUIRED_BACKUP_SURFACES].sort()
    );

    // Postgres artifact must retain full durable columns used by F-13 proof.
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const art = await tx.query(
        `SELECT payload_json FROM backup_artifacts
          WHERE surface = 'postgres_pitr' AND backup_epoch = $1;`,
        [backup.backup_epoch]
      );
      const durable = art.rows[0].payload_json.durable;
      const state = durable.current_state_records.find((s) => s.state_key === fixture.stateKey);
      assert.ok(state);
      assert.ok(state.observed_at, 'observed_at must be captured');
      assert.ok(state.as_of, 'as_of must be captured');
      assert.ok(state.verified_at, 'verified_at must be captured');
      assert.ok(Array.isArray(state.evidence_refs));
      const event = durable.canonical_events.find((e) => e.dedupe_key === fixture.dedupe);
      assert.ok(event);
      assert.equal(event.typed_properties.marker, 'event-props');
      assert.deepEqual(event.subject_refs, ['fixture']);
      assert.equal(event.schema_version, 1);
      assert.equal(event.authenticity_method, 'fixture');
      assert.equal(event.materialized_state, false);

      const git = await tx.query(
        `SELECT payload_json FROM backup_artifacts
          WHERE surface = 'git_remote' AND backup_epoch = $1;`,
        [backup.backup_epoch]
      );
      assert.equal(git.rows[0].payload_json.commit_sha, DEFAULT_GIT_PROVENANCE.commit_sha);
      assert.equal(git.rows[0].payload_json.ref, DEFAULT_GIT_PROVENANCE.ref);
      assert.equal(git.rows[0].payload_json.remote_url, DEFAULT_GIT_PROVENANCE.remote_url);
    });

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

    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const state = await tx.query(
        `SELECT state_id::text, value->>'marker' AS marker, value->>'n' AS n,
                as_of IS NOT NULL AS has_as_of,
                observed_at IS NOT NULL AS has_observed,
                verified_at IS NOT NULL AS has_verified
           FROM current_state_records WHERE state_key = $1;`,
        [fixture.stateKey]
      );
      assert.equal(state.rows.length, 1);
      assert.equal(state.rows[0].state_id, fixture.stateId);
      assert.equal(state.rows[0].marker, 'pre-backup-value');
      assert.equal(state.rows[0].n, '53');
      assert.equal(state.rows[0].has_as_of, true);
      assert.equal(state.rows[0].has_observed, true);
      assert.equal(state.rows[0].has_verified, true);

      const events = await tx.query(
        `SELECT event_id::text, typed_properties->>'marker' AS marker,
                authenticity_method, schema_version
           FROM canonical_events WHERE dedupe_key = $1;`,
        [fixture.dedupe]
      );
      assert.equal(events.rows.length, 1);
      assert.equal(events.rows[0].event_id, fixture.eventId);
      assert.equal(events.rows[0].marker, 'event-props');
      assert.equal(events.rows[0].authenticity_method, 'fixture');
      assert.equal(Number(events.rows[0].schema_version), 1);

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

    await runtime.dbos.assertWritersAllowed();

    const proof = await assertRestoreRehearsed(db, {
      backupEpoch: backup.backup_epoch,
      trustedTenantId: A,
    });
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

    const result = await runtime.runRestoreRehearsal({ backupEpoch: backup.backup_epoch });
    assert.equal(result.status, 'SUCCESS');
  });

  test('incomplete backup surfaces refuse rehearsal (fail-closed)', async () => {
    const runtime = runtimeFor(A);
    await runtime.seedDurableFixture({ stateKey: 'backup.incomplete' });
    const backup = await runtime.createBackupSet({ label: 'will-break' });

    await db.query(
      `DELETE FROM backup_artifacts
        WHERE tenant_id = $1 AND backup_epoch = $2 AND surface = 'git_remote';`,
      [A, backup.backup_epoch]
    );

    await assert.rejects(
      () => runtime.runRestoreRehearsal({ backupEpoch: backup.backup_epoch }),
      (err) => err instanceof BackupRestoreError
        && err.code === 'BACKUP_SURFACES_INCOMPLETE'
        && err.details.missing.includes('git_remote')
    );
  });
});

describe('F-13 tenant isolation of backup epochs/artifacts/runs', () => {
  test('tenant B cannot see, select, rehearse, or assert tenant A backups', async () => {
    const runtimeA = runtimeFor(A);
    const runtimeB = runtimeFor(B);

    await runtimeA.seedDurableFixture({
      stateKey: 'backup.tenant-a.iso',
      value: { marker: 'tenant-a-secret' },
    });
    const backupA = await runtimeA.createBackupSet({ label: 'tenant-a-iso' });

    await asRuntimeTenant(db, 'app_runtime', B, async (tx) => {
      await tx.query(
        `INSERT INTO current_state_records
           (state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
            source_system, max_age_seconds, freshness)
         VALUES ('bbbbbbbb-0000-4000-8000-0000000000b1'::uuid, cur_tenant(),
                 'backup.tenant-b.iso', 'recovery', 'b',
                 '{"marker":"tenant-b-only"}'::jsonb, '1', 'backup_restore', 3600, 'FRESH')
         ON CONFLICT (tenant_id, state_key) DO UPDATE
           SET value = EXCLUDED.value;`
      );
    });
    await runtimeB.seedDurableFixture({
      stateKey: 'backup.tenant-b.seed',
      value: { marker: 'b-seed' },
    });
    const backupB = await runtimeB.createBackupSet({ label: 'tenant-b-iso' });

    await asRuntimeTenant(db, 'app_runtime', B, async (tx) => {
      const aArts = await tx.query(
        `SELECT artifact_id FROM backup_artifacts
          WHERE payload_json->>'label' = 'tenant-a-iso'
             OR payload_json->'durable'->>'tenant_id' = $1;`,
        [A]
      );
      assert.equal(aArts.rows.length, 0, 'tenant B must not see tenant A backup_artifacts');

      const aRuns = await tx.query(
        `SELECT rehearsal_id FROM backup_rehearsal_runs WHERE tenant_id = $1;`,
        [A]
      );
      assert.equal(aRuns.rows.length, 0, 'tenant B must not see tenant A rehearsal runs');

      const aObjs = await tx.query(
        `SELECT version_id FROM object_storage_versions
          WHERE object_key LIKE $1;`,
        [`%${A}%`]
      );
      assert.equal(aObjs.rows.length, 0, 'tenant B must not see tenant A object versions');
    });

    // Remove B's own epoch artifacts when numbers collide so rehearse(A.epoch)
    // cannot accidentally load B's set; A's rows remain RLS-hidden.
    if (backupB.backup_epoch === backupA.backup_epoch) {
      await db.query(
        `DELETE FROM backup_artifacts WHERE tenant_id = $1 AND backup_epoch = $2;`,
        [B, backupB.backup_epoch]
      );
    }
    await assert.rejects(
      () => runtimeB.runRestoreRehearsal({ backupEpoch: backupA.backup_epoch }),
      (err) => err instanceof BackupRestoreError && (
        err.code === 'BACKUP_NOT_FOUND' || err.code === 'BACKUP_SURFACES_INCOMPLETE'
      )
    );

    await runtimeA.runRestoreRehearsal({ backupEpoch: backupA.backup_epoch });

    await asRuntimeTenant(db, 'app_runtime', B, async (tx) => {
      const leaked = await tx.query(
        `SELECT state_key FROM current_state_records
          WHERE state_key = 'backup.tenant-a.iso';`
      );
      assert.equal(leaked.rows.length, 0);
      const bRow = await tx.query(
        `SELECT value->>'marker' AS marker FROM current_state_records
          WHERE state_key = 'backup.tenant-b.iso';`
      );
      assert.equal(bRow.rows.length, 1);
      assert.equal(bRow.rows[0].marker, 'tenant-b-only');

      const aRuns = await tx.query(
        `SELECT rehearsal_id FROM backup_rehearsal_runs WHERE tenant_id = $1;`,
        [A]
      );
      assert.equal(aRuns.rows.length, 0);
    });

    await assert.rejects(
      () => runtimeB.assertRestoreRehearsed({ backupEpoch: backupA.backup_epoch }),
      (err) => err instanceof BackupRestoreError && err.code === 'UNREHEARSED_RESTORE'
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
                 '{"marker":"tenant-b-only"}'::jsonb, '1', 'backup_restore', 3600, 'FRESH')
         ON CONFLICT (tenant_id, state_key) DO UPDATE
           SET value = EXCLUDED.value;`
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

    await assert.rejects(
      () => runtimeB.assertRestoreRehearsed({ backupEpoch: 999999 }),
      (err) => err instanceof BackupRestoreError && err.code === 'UNREHEARSED_RESTORE'
    );
  });
});

describe('F-13 #53 negative restore proofs (fail-closed)', () => {
  test('corrupted postgres backup fingerprint/payload fails rehearsal', async () => {
    const runtime = runtimeFor(A);
    await runtime.seedDurableFixture({
      stateKey: 'backup.corrupt.pg',
      value: { marker: 'pg-ok' },
    });
    const backup = await runtime.createBackupSet({ label: 'corrupt-pg' });

    // Tamper payload without updating content_sha256 → artifact integrity fails.
    await db.query(
      `UPDATE backup_artifacts
          SET payload_json = jsonb_set(
                payload_json,
                '{durable,current_state_records,0,value}',
                '{"marker":"tampered"}'::jsonb
              )
        WHERE tenant_id = $1
          AND backup_epoch = $2
          AND surface = 'postgres_pitr';`,
      [A, backup.backup_epoch]
    );

    await assert.rejects(
      () => runtime.runRestoreRehearsal({ backupEpoch: backup.backup_epoch }),
      (err) => err instanceof BackupRestoreError && (
        err.code === 'BACKUP_ARTIFACT_TAMPERED'
        || err.code === 'POSTGRES_BACKUP_FINGERPRINT_MISMATCH'
        || err.code === 'RESTORE_FINGERPRINT_MISMATCH'
      )
    );
  });

  test('missing or mismatched object-storage version fails at DB/runtime boundary', async () => {
    const runtime = runtimeFor(A);
    await runtime.seedDurableFixture({
      stateKey: 'backup.corrupt.obj',
      value: { marker: 'obj-ok' },
    });
    const backup = await runtime.createBackupSet({ label: 'corrupt-obj' });

    await db.query(
      `UPDATE object_storage_versions
          SET content_sha256 = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
        WHERE tenant_id = $1
          AND object_key LIKE $2;`,
      [A, `%/${backup.backup_epoch}.json`]
    );

    await assert.rejects(
      () => runtime.runRestoreRehearsal({ backupEpoch: backup.backup_epoch }),
      (err) => err instanceof BackupRestoreError && err.code === 'OBJECT_STORAGE_MISMATCH'
    );

    await runtime.seedDurableFixture({
      stateKey: 'backup.missing.obj',
      value: { marker: 'obj-missing' },
    });
    const backup2 = await runtime.createBackupSet({ label: 'missing-obj' });
    await db.query(
      `DELETE FROM object_storage_versions
        WHERE tenant_id = $1 AND object_key LIKE $2;`,
      [A, `%/${backup2.backup_epoch}.json`]
    );
    await assert.rejects(
      () => runtime.runRestoreRehearsal({ backupEpoch: backup2.backup_epoch }),
      (err) => err instanceof BackupRestoreError && err.code === 'OBJECT_STORAGE_MISSING'
    );
  });

  test('mismatched git provenance fails rehearsal', async () => {
    const writer = runtimeFor(A);
    await writer.seedDurableFixture({
      stateKey: 'backup.corrupt.git',
      value: { marker: 'git-ok' },
    });
    const backup = await writer.createBackupSet({ label: 'corrupt-git' });

    // Rehearse with different non-secret commit provenance → mismatch at verify.
    const mismatched = runtimeFor(A, {
      gitCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    await assert.rejects(
      () => mismatched.runRestoreRehearsal({ backupEpoch: backup.backup_epoch }),
      (err) => err instanceof BackupRestoreError && err.code === 'GIT_PROVENANCE_MISMATCH'
    );
  });

  test('missing derived-index rebuild fails closed', async () => {
    const runtime = runtimeFor(A);
    await runtime.seedDurableFixture({
      stateKey: 'backup.corrupt.idx',
      value: { marker: 'idx-ok' },
    });
    const backup = await runtime.createBackupSet({ label: 'corrupt-idx' });

    const badPayload = {
      kinds: ['pgvector', 'fts'],
      source_key: 'backup-epoch-missing',
      content_sha256: null,
    };
    await db.query(
      `UPDATE backup_artifacts
          SET payload_json = $3::jsonb,
              content_sha256 = $4
        WHERE tenant_id = $1
          AND backup_epoch = $2
          AND surface = 'derived_indexes';`,
      [A, backup.backup_epoch, JSON.stringify(badPayload), fingerprintPayload(badPayload)]
    );

    await assert.rejects(
      () => runtime.runRestoreRehearsal({ backupEpoch: backup.backup_epoch }),
      (err) => err instanceof BackupRestoreError && (
        err.code === 'INVALID_DERIVED_BACKUP'
        || err.code === 'DERIVED_INDEX_REBUILD_MISSING'
      )
    );
  });

  test('SUCCESS constraint rejects premature writer thaw proof', async () => {
    await assert.rejects(async () => {
      await db.query(
        `INSERT INTO backup_rehearsal_runs
           (rehearsal_id, tenant_id, backup_epoch, status, writers_frozen,
            postgres_restored, derived_indexes_rebuilt, dbos_reconciled,
            providers_reconciled, writers_reactivated,
            pre_restore_fingerprint, post_restore_fingerprint, completed_at)
         VALUES (
           'cccccccc-0000-4000-8000-0000000000cc'::uuid,
           $1, 1, 'SUCCESS', true,
           true, true, true,
           true, false,
           'abc', 'abc', now()
         );`,
        [A]
      );
    }, (err) => /backup_rehearsal_success_requires_proof|check constraint/i.test(String(err.message || err)));
  });
});
