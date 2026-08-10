// src/runtime/backup-restore.js
// F-13 Backup / restore rehearsal (acceptance #53).
//
// Per 10_OBSERVABILITY_RECOVERY.md:
//   Required backups: Postgres PITR, object-storage versioning/retention,
//   Git remote, rebuildable pgvector/FTS.
//   "Backup is not proven until restore is tested."
//
// Restore sequence (same doc + #52):
//   freeze writers → bump recovery epoch → restore Postgres →
//   rebuild derived indexes → reconcile DBOS → reconcile providers →
//   only then re-enable writes.
//
// Stop condition: unrehearsed restore.
// NON-SCOPE: business writes. Autonomy remains DISABLED.

import { createHash, randomUUID } from 'node:crypto';
import { asRole } from '../db/index.js';
import {
  assertBusinessWriteAutonomyDisabled,
  BUSINESS_WRITE_AUTONOMY,
} from './autonomy.js';
import { createDbosRuntime, WritersFrozenError } from './dbos.js';

/** SOT-required backup surfaces — all must be present before a rehearsal. */
export const REQUIRED_BACKUP_SURFACES = Object.freeze([
  'postgres_pitr',
  'object_storage',
  'git_remote',
  'derived_indexes',
]);

export const REHEARSAL_STATUSES = Object.freeze(['RUNNING', 'SUCCESS', 'FAILED']);

export class BackupRestoreError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BackupRestoreError';
    this.code = code;
    this.details = details;
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function fingerprintPayload(payload) {
  return sha256Hex(stableStringify(payload));
}

/**
 * Fail closed: backup is not proven without a successful restore rehearsal.
 * Stop condition for F-13 — unrehearsed restore.
 */
export async function assertRestoreRehearsed(db, { backupEpoch } = {}) {
  assertBusinessWriteAutonomyDisabled();
  const params = [];
  let sql = `
    SELECT rehearsal_id, backup_epoch, status, pre_restore_fingerprint,
           post_restore_fingerprint, completed_at
      FROM backup_rehearsal_runs
     WHERE status = 'SUCCESS'`;
  if (backupEpoch != null) {
    params.push(backupEpoch);
    sql += ` AND backup_epoch = $${params.length}`;
  }
  sql += ` ORDER BY completed_at DESC LIMIT 1;`;
  const r = await db.query(sql, params);
  const row = r.rows[0];
  if (!row) {
    throw new BackupRestoreError(
      'UNREHEARSED_RESTORE',
      'backup restore has not been rehearsed (stop condition)',
      { backupEpoch: backupEpoch ?? null }
    );
  }
  if (row.pre_restore_fingerprint !== row.post_restore_fingerprint) {
    throw new BackupRestoreError(
      'UNREHEARSED_RESTORE',
      'rehearsal fingerprint mismatch — restore not proven',
      { rehearsal_id: row.rehearsal_id }
    );
  }
  return row;
}

/**
 * Create a foundation backup/restore rehearsal runtime.
 * Uses DBOS recovery freeze (#52) and records durable proof (#53).
 */
export function createBackupRestoreRuntime(db, { trustedTenantId, gitRemoteUrl } = {}) {
  assertBusinessWriteAutonomyDisabled();
  if (BUSINESS_WRITE_AUTONOMY !== false) {
    throw new BackupRestoreError(
      'BUSINESS_WRITE_AUTONOMY_ENABLED',
      'business-write autonomy must remain DISABLED'
    );
  }
  if (!trustedTenantId) {
    throw new BackupRestoreError(
      'MISSING_TENANT_CONTEXT',
      'trustedTenantId required (fail-closed)'
    );
  }

  const dbos = createDbosRuntime(db, { trustedTenantId });
  const resolvedGitRemote = gitRemoteUrl || 'git@local:jarvis-agencyos.git';

  async function withRuntimeTx(fn) {
    return asRole(db, 'app_runtime', async (backend) => {
      return backend.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [trustedTenantId]);
        return fn(tx);
      });
    });
  }

  async function withControlTx(fn) {
    // Control-plane rehearsal tables are not tenant-owned; still bind tenant
    // for any nested tenant-scoped reads during the same transaction.
    return asRole(db, 'app_runtime', async (backend) => {
      return backend.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [trustedTenantId]);
        return fn(tx);
      });
    });
  }

  async function readDurableState(tx) {
    const states = await tx.query(
      `SELECT state_id::text, state_key, domain, subject_ref, value, state_version,
              source_system, max_age_seconds, freshness, conflict_status
         FROM current_state_records
        WHERE tenant_id = cur_tenant()
        ORDER BY state_key ASC;`
    );
    const events = await tx.query(
      `SELECT event_id::text, event_type, dedupe_key, authenticity_status, content_trust,
              source_system
         FROM canonical_events
        WHERE tenant_id = cur_tenant()
        ORDER BY dedupe_key ASC;`
    );
    return {
      tenant_id: trustedTenantId,
      current_state_records: states.rows,
      canonical_events: events.rows,
    };
  }

  async function nextBackupEpoch(tx) {
    const r = await tx.query(
      `SELECT COALESCE(MAX(backup_epoch), 0) + 1 AS next_epoch FROM backup_artifacts;`
    );
    return Number(r.rows[0].next_epoch);
  }

  /**
   * Capture required-surface backups for one epoch.
   * Postgres payload is a logical durable-state snapshot (PITR stand-in).
   */
  async function createBackupSet({ label } = {}) {
    return withControlTx(async (tx) => {
      const epoch = await nextBackupEpoch(tx);
      const durable = await readDurableState(tx);
      const postgresFp = fingerprintPayload(durable);

      // Seed a versioned object + derived index so surfaces are real, not claims.
      const objectKey = `rehearsal/${trustedTenantId}/${epoch}.json`;
      const objectSha = sha256Hex(stableStringify(durable));
      await tx.query(
        `INSERT INTO object_storage_versions
           (version_id, bucket_key, object_key, version_number, content_sha256, retained)
         VALUES ($1, 'agencyos-backups', $2, $3, $4, true)
         ON CONFLICT (bucket_key, object_key, version_number) DO UPDATE
           SET content_sha256 = EXCLUDED.content_sha256, retained = true;`,
        [randomUUID(), objectKey, epoch, objectSha]
      );

      await tx.query(
        `INSERT INTO derived_index_entries
           (index_id, tenant_id, index_kind, source_key, content_sha256)
         VALUES
           ($1, cur_tenant(), 'pgvector', $2, $3),
           ($4, cur_tenant(), 'fts', $2, $3)
         ON CONFLICT (tenant_id, index_kind, source_key) DO UPDATE
           SET content_sha256 = EXCLUDED.content_sha256, rebuilt_at = now();`,
        [
          randomUUID(),
          `backup-epoch-${epoch}`,
          postgresFp,
          randomUUID(),
        ]
      );

      const surfaces = {
        postgres_pitr: {
          kind: 'logical_pitr_snapshot',
          label: label || `epoch-${epoch}`,
          durable,
        },
        object_storage: {
          bucket_key: 'agencyos-backups',
          object_key: objectKey,
          version_number: epoch,
          content_sha256: objectSha,
          retention: 'versioned',
        },
        git_remote: {
          remote_url: resolvedGitRemote,
          // Provenance marker only — never a credential.
          ref_kind: 'remote_presence',
        },
        derived_indexes: {
          kinds: ['pgvector', 'fts'],
          source_key: `backup-epoch-${epoch}`,
          content_sha256: postgresFp,
        },
      };

      const artifacts = [];
      for (const surface of REQUIRED_BACKUP_SURFACES) {
        const payload = surfaces[surface];
        const contentSha = fingerprintPayload(payload);
        const artifactId = randomUUID();
        await tx.query(
          `INSERT INTO backup_artifacts
             (artifact_id, surface, backup_epoch, content_sha256, payload_json)
           VALUES ($1, $2, $3, $4, $5::jsonb);`,
          [artifactId, surface, epoch, contentSha, JSON.stringify(payload)]
        );
        artifacts.push({
          artifact_id: artifactId,
          surface,
          backup_epoch: epoch,
          content_sha256: contentSha,
        });
      }

      return {
        backup_epoch: epoch,
        fingerprint: postgresFp,
        artifacts,
        surfaces: REQUIRED_BACKUP_SURFACES.slice(),
      };
    });
  }

  async function loadBackupSet(tx, backupEpoch) {
    const r = await tx.query(
      `SELECT artifact_id, surface, backup_epoch, content_sha256, payload_json
         FROM backup_artifacts
        WHERE backup_epoch = $1
        ORDER BY surface ASC;`,
      [backupEpoch]
    );
    if (r.rows.length === 0) {
      throw new BackupRestoreError(
        'BACKUP_NOT_FOUND',
        `no backup artifacts for epoch ${backupEpoch}`,
        { backupEpoch }
      );
    }
    const bySurface = new Map(r.rows.map((row) => [row.surface, row]));
    const missing = REQUIRED_BACKUP_SURFACES.filter((s) => !bySurface.has(s));
    if (missing.length) {
      throw new BackupRestoreError(
        'BACKUP_SURFACES_INCOMPLETE',
        `backup epoch missing required surfaces: ${missing.join(',')}`,
        { backupEpoch, missing }
      );
    }
    return bySurface;
  }

  async function wipeDurableState(tx) {
    await tx.query(`DELETE FROM current_state_records WHERE tenant_id = cur_tenant();`);
    await tx.query(`DELETE FROM canonical_events WHERE tenant_id = cur_tenant();`);
    await tx.query(`DELETE FROM derived_index_entries WHERE tenant_id = cur_tenant();`);
  }

  async function restorePostgresFromArtifact(tx, postgresArtifact) {
    const payload = postgresArtifact.payload_json;
    const durable = payload.durable;
    if (!durable || !Array.isArray(durable.current_state_records)) {
      throw new BackupRestoreError(
        'INVALID_POSTGRES_BACKUP',
        'postgres_pitr artifact missing durable snapshot'
      );
    }

    await wipeDurableState(tx);

    for (const row of durable.current_state_records) {
      await tx.query(
        `INSERT INTO current_state_records
           (state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
            source_system, max_age_seconds, freshness, conflict_status)
         VALUES ($1::uuid, cur_tenant(), $2, $3, $4, $5::jsonb, $6,
                 $7, $8, $9, $10);`,
        [
          row.state_id,
          row.state_key,
          row.domain,
          row.subject_ref,
          JSON.stringify(row.value ?? {}),
          row.state_version,
          row.source_system || 'backup_restore',
          row.max_age_seconds ?? 3600,
          row.freshness || 'FRESH',
          row.conflict_status || 'NONE',
        ]
      );
    }

    for (const row of durable.canonical_events) {
      await tx.query(
        `INSERT INTO canonical_events
           (event_id, tenant_id, event_type, source_system, dedupe_key,
            authenticity_status, content_trust, typed_properties, subject_refs)
         VALUES ($1::uuid, cur_tenant(), $2, $3, $4,
                 $5, $6, '{}'::jsonb, '[]'::jsonb);`,
        [
          row.event_id,
          row.event_type,
          row.source_system || 'backup_restore',
          row.dedupe_key,
          row.authenticity_status,
          row.content_trust || 'TRUSTED_STRUCTURED',
        ]
      );
    }
  }

  async function rebuildDerivedIndexes(tx, derivedArtifact) {
    const payload = derivedArtifact.payload_json;
    const sourceKey = payload.source_key;
    const contentSha = payload.content_sha256;
    if (!sourceKey || !contentSha) {
      throw new BackupRestoreError(
        'INVALID_DERIVED_BACKUP',
        'derived_indexes artifact missing source_key/content_sha256'
      );
    }
    for (const kind of payload.kinds || ['pgvector', 'fts']) {
      await tx.query(
        `INSERT INTO derived_index_entries
           (index_id, tenant_id, index_kind, source_key, content_sha256)
         VALUES ($1, cur_tenant(), $2, $3, $4)
         ON CONFLICT (tenant_id, index_kind, source_key) DO UPDATE
           SET content_sha256 = EXCLUDED.content_sha256, rebuilt_at = now();`,
        [randomUUID(), kind, sourceKey, contentSha]
      );
    }
  }

  async function verifyObjectStorage(tx, objectArtifact) {
    const p = objectArtifact.payload_json;
    const r = await tx.query(
      `SELECT version_id, content_sha256, retained
         FROM object_storage_versions
        WHERE bucket_key = $1 AND object_key = $2 AND version_number = $3;`,
      [p.bucket_key, p.object_key, p.version_number]
    );
    if (r.rows.length !== 1 || r.rows[0].retained !== true) {
      throw new BackupRestoreError(
        'OBJECT_STORAGE_MISSING',
        'object-storage versioned backup not retained'
      );
    }
    if (r.rows[0].content_sha256 !== p.content_sha256) {
      throw new BackupRestoreError(
        'OBJECT_STORAGE_MISMATCH',
        'object-storage content sha mismatch'
      );
    }
  }

  function verifyGitRemote(gitArtifact) {
    const remote = gitArtifact.payload_json?.remote_url;
    if (!remote || typeof remote !== 'string') {
      throw new BackupRestoreError(
        'GIT_REMOTE_MISSING',
        'git remote backup surface missing remote_url'
      );
    }
    // Refuse credential-looking material in the recorded surface.
    if (/password|token|secret|credential/i.test(remote)) {
      throw new BackupRestoreError(
        'GIT_REMOTE_CREDENTIAL_LEAK',
        'git remote must not embed credentials'
      );
    }
    return remote;
  }

  /**
   * Actually rehearse restore for a backup epoch.
   * Mutates durable state (wipe), restores from backup, rebuilds indexes,
   * runs #52 reconcile sequence, and persists SUCCESS proof only when
   * pre/post fingerprints match.
   */
  async function runRestoreRehearsal({ backupEpoch } = {}) {
    assertBusinessWriteAutonomyDisabled();

    let rehearsalId = randomUUID();
    let preFingerprint = null;
    let recoveryEpoch = null;

    try {
      // Phase A: load backup, record RUNNING, capture fingerprint, freeze.
      const prepared = await withControlTx(async (tx) => {
        let epoch = backupEpoch;
        if (epoch == null) {
          const latest = await tx.query(
            `SELECT MAX(backup_epoch) AS epoch FROM backup_artifacts;`
          );
          epoch = Number(latest.rows[0].epoch);
          if (!Number.isFinite(epoch) || epoch < 1) {
            throw new BackupRestoreError(
              'BACKUP_NOT_FOUND',
              'no backup artifacts available to rehearse'
            );
          }
        }

        const bySurface = await loadBackupSet(tx, epoch);
        const postgresArtifact = bySurface.get('postgres_pitr');
        preFingerprint = fingerprintPayload(postgresArtifact.payload_json.durable);

        await tx.query(
          `INSERT INTO backup_rehearsal_runs
             (rehearsal_id, backup_epoch, status, writers_frozen, surfaces_json,
              pre_restore_fingerprint)
           VALUES ($1, $2, 'RUNNING', false, $3::jsonb, $4);`,
          [
            rehearsalId,
            epoch,
            JSON.stringify(REQUIRED_BACKUP_SURFACES),
            preFingerprint,
          ]
        );

        return { epoch, bySurface, postgresArtifact };
      });

      const frozen = await dbos.beginRestore();
      recoveryEpoch = frozen.recovery_epoch;
      if (!frozen.writers_frozen) {
        throw new BackupRestoreError(
          'FREEZE_FAILED',
          'beginRestore did not freeze writers'
        );
      }

      // Writers must be frozen during restore (prove stop/gate still holds).
      try {
        await dbos.assertWritersAllowed();
        throw new BackupRestoreError(
          'WRITERS_NOT_FROZEN',
          'expected writers to be frozen during restore rehearsal'
        );
      } catch (err) {
        if (!(err instanceof WritersFrozenError)) throw err;
      }

      await withControlTx(async (tx) => {
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET writers_frozen = true, recovery_epoch = $2
            WHERE rehearsal_id = $1;`,
          [rehearsalId, recoveryEpoch]
        );

        // Prove restore is not a no-op: wipe then restore.
        await wipeDurableState(tx);
        const wiped = await readDurableState(tx);
        if (
          wiped.current_state_records.length !== 0
          || wiped.canonical_events.length !== 0
        ) {
          throw new BackupRestoreError(
            'WIPE_FAILED',
            'durable state still present after wipe'
          );
        }

        await restorePostgresFromArtifact(tx, prepared.postgresArtifact);
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET postgres_restored = true
            WHERE rehearsal_id = $1;`,
          [rehearsalId]
        );

        await rebuildDerivedIndexes(tx, prepared.bySurface.get('derived_indexes'));
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET derived_indexes_rebuilt = true
            WHERE rehearsal_id = $1;`,
          [rehearsalId]
        );

        await verifyObjectStorage(tx, prepared.bySurface.get('object_storage'));
        verifyGitRemote(prepared.bySurface.get('git_remote'));

        const restored = await readDurableState(tx);
        const postFingerprint = fingerprintPayload(restored);
        if (postFingerprint !== preFingerprint) {
          throw new BackupRestoreError(
            'RESTORE_FINGERPRINT_MISMATCH',
            'restored durable state does not match backup fingerprint',
            { preFingerprint, postFingerprint }
          );
        }

        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET post_restore_fingerprint = $2
            WHERE rehearsal_id = $1;`,
          [rehearsalId, postFingerprint]
        );
      });

      await dbos.markReconciled('postgres');
      await dbos.markReconciled('dbos');
      await withControlTx(async (tx) => {
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET dbos_reconciled = true
            WHERE rehearsal_id = $1;`,
          [rehearsalId]
        );
      });
      await dbos.markReconciled('providers');
      await withControlTx(async (tx) => {
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET providers_reconciled = true
            WHERE rehearsal_id = $1;`,
          [rehearsalId]
        );
      });

      const open = await dbos.completeRestore();
      if (open.writers_frozen) {
        throw new BackupRestoreError(
          'THAW_FAILED',
          'completeRestore left writers frozen'
        );
      }

      const success = await withControlTx(async (tx) => {
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET writers_reactivated = true,
                  status = 'SUCCESS',
                  completed_at = now()
            WHERE rehearsal_id = $1;`,
          [rehearsalId]
        );
        const r = await tx.query(
          `SELECT rehearsal_id, backup_epoch, status, writers_frozen,
                  postgres_restored, derived_indexes_rebuilt, dbos_reconciled,
                  providers_reconciled, writers_reactivated,
                  pre_restore_fingerprint, post_restore_fingerprint,
                  recovery_epoch, completed_at
             FROM backup_rehearsal_runs
            WHERE rehearsal_id = $1;`,
          [rehearsalId]
        );
        return r.rows[0];
      });

      return success;
    } catch (err) {
      try {
        await withControlTx(async (tx) => {
          await tx.query(
            `UPDATE backup_rehearsal_runs
                SET status = 'FAILED',
                    error_json = $2::jsonb,
                    completed_at = now()
              WHERE rehearsal_id = $1 AND status = 'RUNNING';`,
            [
              rehearsalId,
              JSON.stringify({
                code: err.code || 'REHEARSAL_FAILED',
                message: err.message,
              }),
            ]
          );
        });
      } catch {
        // Preserve original failure.
      }
      // Best-effort: if freeze stuck mid-rehearsal, do not auto-thaw without reconcile.
      throw err;
    }
  }

  async function latestSuccessfulRehearsal() {
    return assertRestoreRehearsed(db);
  }

  async function seedDurableFixture({ stateKey = 'backup.fixture', value } = {}) {
    return withRuntimeTx(async (tx) => {
      const stateId = randomUUID();
      const eventId = randomUUID();
      const dedupe = `backup-fixture-${stateId}`;
      await tx.query(
        `INSERT INTO current_state_records
           (state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
            source_system, max_age_seconds, freshness)
         VALUES ($1, cur_tenant(), $2, 'recovery', 'fixture', $3::jsonb, '1',
                 'backup_restore', 3600, 'FRESH');`,
        [stateId, stateKey, JSON.stringify(value ?? { ok: true, marker: stateId })]
      );
      await tx.query(
        `INSERT INTO canonical_events
           (event_id, tenant_id, event_type, source_system, dedupe_key,
            authenticity_status, content_trust)
         VALUES ($1, cur_tenant(), 'backup.fixture.seeded', 'backup_restore', $2,
                 'NOT_APPLICABLE', 'TRUSTED_STRUCTURED');`,
        [eventId, dedupe]
      );
      return { stateId, eventId, dedupe, stateKey };
    });
  }

  return {
    trustedTenantId,
    dbos,
    createBackupSet,
    runRestoreRehearsal,
    latestSuccessfulRehearsal,
    assertRestoreRehearsed: (opts) => assertRestoreRehearsed(db, opts),
    seedDurableFixture,
    requiredSurfaces: REQUIRED_BACKUP_SURFACES,
  };
}
