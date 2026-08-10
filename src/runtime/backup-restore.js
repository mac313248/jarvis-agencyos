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
// Tenant isolation: backup_artifacts / backup_rehearsal_runs / object_storage
// versions are tenant-owned; backup_epoch cannot cross tenants.
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

/** Deterministic non-secret git provenance used by F-13 rehearsal fixtures. */
export const DEFAULT_GIT_PROVENANCE = Object.freeze({
  remote_url: 'git@local:jarvis-agencyos.git',
  remote_name: 'origin',
  ref: 'refs/heads/phase-build/f-13',
  // Synthetic 40-char hex — not a live secret, not a production credential.
  commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
});

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

function normalizeTs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

/**
 * Fail closed: backup is not proven without a successful restore rehearsal.
 * Stop condition for F-13 — unrehearsed restore.
 * Must run under trusted tenant context (RLS + FORCE RLS).
 */
export async function assertRestoreRehearsed(db, { backupEpoch, trustedTenantId } = {}) {
  assertBusinessWriteAutonomyDisabled();
  if (!trustedTenantId) {
    throw new BackupRestoreError(
      'MISSING_TENANT_CONTEXT',
      'trustedTenantId required to assert restore rehearsal (fail-closed)'
    );
  }
  return asRole(db, 'app_runtime', async (backend) => {
    return backend.tx(async (tx) => {
      await tx.query('SELECT set_tenant($1);', [trustedTenantId]);
      const params = [];
      let sql = `
        SELECT rehearsal_id, backup_epoch, status, pre_restore_fingerprint,
               post_restore_fingerprint, completed_at
          FROM backup_rehearsal_runs
         WHERE status = 'SUCCESS'
           AND tenant_id = cur_tenant()`;
      if (backupEpoch != null) {
        params.push(backupEpoch);
        sql += ` AND backup_epoch = $${params.length}`;
      }
      sql += ` ORDER BY completed_at DESC LIMIT 1;`;
      const r = await tx.query(sql, params);
      const row = r.rows[0];
      if (!row) {
        throw new BackupRestoreError(
          'UNREHEARSED_RESTORE',
          'backup restore has not been rehearsed (stop condition)',
          { backupEpoch: backupEpoch ?? null, tenant_id: trustedTenantId }
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
    });
  });
}

/**
 * Create a foundation backup/restore rehearsal runtime.
 * Uses DBOS recovery freeze (#52) and records durable proof (#53).
 */
export function createBackupRestoreRuntime(db, {
  trustedTenantId,
  gitRemoteUrl,
  gitRemoteName,
  gitRef,
  gitCommitSha,
} = {}) {
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

  const gitProvenance = {
    remote_url: gitRemoteUrl || DEFAULT_GIT_PROVENANCE.remote_url,
    remote_name: gitRemoteName || DEFAULT_GIT_PROVENANCE.remote_name,
    ref: gitRef || DEFAULT_GIT_PROVENANCE.ref,
    commit_sha: gitCommitSha || DEFAULT_GIT_PROVENANCE.commit_sha,
  };
  if (!isCommitSha(gitProvenance.commit_sha)) {
    throw new BackupRestoreError(
      'INVALID_GIT_PROVENANCE',
      'gitCommitSha must be a 40-char hex commit id (non-secret provenance)'
    );
  }
  if (!gitProvenance.ref || typeof gitProvenance.ref !== 'string') {
    throw new BackupRestoreError(
      'INVALID_GIT_PROVENANCE',
      'gitRef required for non-secret git provenance'
    );
  }
  if (/password|token|secret|credential/i.test(gitProvenance.remote_url)) {
    throw new BackupRestoreError(
      'GIT_REMOTE_CREDENTIAL_LEAK',
      'git remote must not embed credentials'
    );
  }

  const dbos = createDbosRuntime(db, { trustedTenantId });

  async function withRuntimeTx(fn) {
    return asRole(db, 'app_runtime', async (backend) => {
      return backend.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [trustedTenantId]);
        return fn(tx);
      });
    });
  }

  async function withTenantTx(fn) {
    return asRole(db, 'app_runtime', async (backend) => {
      return backend.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [trustedTenantId]);
        return fn(tx);
      });
    });
  }

  /**
   * Canonical durable rows used by F-13 restore proof — full column set so
   * restore comparison cannot omit fields required to prove PITR semantics.
   */
  async function readDurableState(tx) {
    const states = await tx.query(
      `SELECT state_id::text,
              state_key,
              domain,
              subject_ref,
              value,
              state_version,
              source_system,
              as_of,
              observed_at,
              verified_at,
              max_age_seconds,
              freshness,
              conflict_status,
              last_event_id::text,
              evidence_refs
         FROM current_state_records
        WHERE tenant_id = cur_tenant()
        ORDER BY state_key ASC;`
    );
    const events = await tx.query(
      `SELECT event_id::text,
              event_type,
              source_system,
              source_connection_id::text,
              source_event_id,
              occurred_at,
              received_at,
              subject_refs,
              typed_properties,
              dedupe_key,
              evidence_ref::text,
              schema_version,
              authenticity_status,
              authenticity_method,
              content_trust,
              verification_evidence_ref::text,
              materialized_state
         FROM canonical_events
        WHERE tenant_id = cur_tenant()
        ORDER BY dedupe_key ASC;`
    );
    return {
      tenant_id: trustedTenantId,
      current_state_records: states.rows.map((row) => ({
        ...row,
        as_of: normalizeTs(row.as_of),
        observed_at: normalizeTs(row.observed_at),
        verified_at: normalizeTs(row.verified_at),
      })),
      canonical_events: events.rows.map((row) => ({
        ...row,
        occurred_at: normalizeTs(row.occurred_at),
        received_at: normalizeTs(row.received_at),
      })),
    };
  }

  async function nextBackupEpoch(tx) {
    const r = await tx.query(
      `SELECT COALESCE(MAX(backup_epoch), 0) + 1 AS next_epoch
         FROM backup_artifacts
        WHERE tenant_id = cur_tenant();`
    );
    return Number(r.rows[0].next_epoch);
  }

  /**
   * Capture required-surface backups for one epoch.
   * Postgres payload is a logical durable-state snapshot proving restore
   * semantics for the F-13 scope (isolated PITR stand-in, not production).
   */
  async function createBackupSet({ label } = {}) {
    return withTenantTx(async (tx) => {
      const epoch = await nextBackupEpoch(tx);
      const durable = await readDurableState(tx);
      const postgresFp = fingerprintPayload(durable);

      const objectKey = `rehearsal/${trustedTenantId}/${epoch}.json`;
      const objectSha = sha256Hex(stableStringify(durable));
      await tx.query(
        `INSERT INTO object_storage_versions
           (version_id, tenant_id, bucket_key, object_key, version_number,
            content_sha256, retained)
         VALUES ($1, cur_tenant(), 'agencyos-backups', $2, $3, $4, true)
         ON CONFLICT (tenant_id, bucket_key, object_key, version_number) DO UPDATE
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
          content_fingerprint: postgresFp,
        },
        object_storage: {
          bucket_key: 'agencyos-backups',
          object_key: objectKey,
          version_number: epoch,
          content_sha256: objectSha,
          retention: 'versioned',
          expected_durable_fingerprint: postgresFp,
        },
        git_remote: {
          ...gitProvenance,
          // Provenance metadata only — never a credential.
          provenance_kind: 'commit_ref_remote',
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
             (artifact_id, tenant_id, surface, backup_epoch, content_sha256, payload_json)
           VALUES ($1, cur_tenant(), $2, $3, $4, $5::jsonb);`,
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
        WHERE tenant_id = cur_tenant()
          AND backup_epoch = $1
        ORDER BY surface ASC;`,
      [backupEpoch]
    );
    if (r.rows.length === 0) {
      throw new BackupRestoreError(
        'BACKUP_NOT_FOUND',
        `no backup artifacts for epoch ${backupEpoch}`,
        { backupEpoch, tenant_id: trustedTenantId }
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
    // Integrity: stored content_sha256 must still match payload (tamper detect).
    for (const row of r.rows) {
      const recomputed = fingerprintPayload(row.payload_json);
      if (recomputed !== row.content_sha256) {
        throw new BackupRestoreError(
          'BACKUP_ARTIFACT_TAMPERED',
          `backup artifact fingerprint mismatch for surface ${row.surface}`,
          { surface: row.surface, backupEpoch }
        );
      }
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
    if (durable.tenant_id && durable.tenant_id !== trustedTenantId) {
      throw new BackupRestoreError(
        'TENANT_BOUNDARY_VIOLATION',
        'postgres backup tenant_id does not match trusted tenant context',
        { backup_tenant_id: durable.tenant_id, trustedTenantId }
      );
    }
    if (payload.content_fingerprint) {
      const recomputed = fingerprintPayload(durable);
      if (recomputed !== payload.content_fingerprint) {
        throw new BackupRestoreError(
          'POSTGRES_BACKUP_FINGERPRINT_MISMATCH',
          'postgres_pitr durable payload does not match recorded fingerprint',
          { expected: payload.content_fingerprint, actual: recomputed }
        );
      }
    }

    await wipeDurableState(tx);

    for (const row of durable.current_state_records) {
      await tx.query(
        `INSERT INTO current_state_records
           (state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
            source_system, as_of, observed_at, verified_at, max_age_seconds,
            freshness, conflict_status, last_event_id, evidence_refs)
         VALUES ($1::uuid, cur_tenant(), $2, $3, $4, $5::jsonb, $6,
                 $7, $8::timestamptz, COALESCE($9::timestamptz, now()),
                 $10::timestamptz, $11, $12, $13,
                 $14::uuid, COALESCE($15::jsonb, '[]'::jsonb));`,
        [
          row.state_id,
          row.state_key,
          row.domain,
          row.subject_ref,
          JSON.stringify(row.value ?? {}),
          row.state_version,
          row.source_system || 'backup_restore',
          row.as_of ?? null,
          row.observed_at ?? null,
          row.verified_at ?? null,
          row.max_age_seconds ?? 3600,
          row.freshness || 'FRESH',
          row.conflict_status || 'NONE',
          row.last_event_id ?? null,
          JSON.stringify(row.evidence_refs ?? []),
        ]
      );
    }

    for (const row of durable.canonical_events || []) {
      await tx.query(
        `INSERT INTO canonical_events
           (event_id, tenant_id, event_type, source_system, source_connection_id,
            source_event_id, occurred_at, received_at, subject_refs, typed_properties,
            dedupe_key, evidence_ref, schema_version, authenticity_status,
            authenticity_method, content_trust, verification_evidence_ref,
            materialized_state)
         VALUES ($1::uuid, cur_tenant(), $2, $3, $4::uuid,
                 $5, $6::timestamptz, COALESCE($7::timestamptz, now()),
                 COALESCE($8::jsonb, '[]'::jsonb), COALESCE($9::jsonb, '{}'::jsonb),
                 $10, $11::uuid, COALESCE($12, 1), $13,
                 $14, $15, $16::uuid,
                 COALESCE($17, false));`,
        [
          row.event_id,
          row.event_type,
          row.source_system || 'backup_restore',
          row.source_connection_id ?? null,
          row.source_event_id ?? null,
          row.occurred_at ?? null,
          row.received_at ?? null,
          JSON.stringify(row.subject_refs ?? []),
          JSON.stringify(row.typed_properties ?? {}),
          row.dedupe_key,
          row.evidence_ref ?? null,
          row.schema_version ?? 1,
          row.authenticity_status,
          row.authenticity_method ?? null,
          row.content_trust || 'TRUSTED_STRUCTURED',
          row.verification_evidence_ref ?? null,
          row.materialized_state ?? false,
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

  async function assertDerivedIndexesRebuilt(tx, derivedArtifact) {
    const payload = derivedArtifact.payload_json;
    const kinds = payload.kinds || ['pgvector', 'fts'];
    const r = await tx.query(
      `SELECT index_kind, content_sha256
         FROM derived_index_entries
        WHERE tenant_id = cur_tenant()
          AND source_key = $1
        ORDER BY index_kind ASC;`,
      [payload.source_key]
    );
    if (r.rows.length !== kinds.length) {
      throw new BackupRestoreError(
        'DERIVED_INDEX_REBUILD_MISSING',
        'derived indexes were not rebuilt after wipe',
        { expected: kinds.length, actual: r.rows.length }
      );
    }
    for (const row of r.rows) {
      if (row.content_sha256 !== payload.content_sha256) {
        throw new BackupRestoreError(
          'DERIVED_INDEX_REBUILD_MISMATCH',
          'derived index content sha mismatch after rebuild',
          { index_kind: row.index_kind }
        );
      }
    }
  }

  async function verifyObjectStorage(tx, objectArtifact) {
    const p = objectArtifact.payload_json;
    if (!p?.bucket_key || !p?.object_key || p.version_number == null || !p.content_sha256) {
      throw new BackupRestoreError(
        'OBJECT_STORAGE_INVALID',
        'object-storage artifact missing version identity'
      );
    }
    const r = await tx.query(
      `SELECT version_id, content_sha256, retained
         FROM object_storage_versions
        WHERE tenant_id = cur_tenant()
          AND bucket_key = $1 AND object_key = $2 AND version_number = $3;`,
      [p.bucket_key, p.object_key, p.version_number]
    );
    if (r.rows.length !== 1 || r.rows[0].retained !== true) {
      throw new BackupRestoreError(
        'OBJECT_STORAGE_MISSING',
        'object-storage versioned backup not retained',
        {
          bucket_key: p.bucket_key,
          object_key: p.object_key,
          version_number: p.version_number,
        }
      );
    }
    if (r.rows[0].content_sha256 !== p.content_sha256) {
      throw new BackupRestoreError(
        'OBJECT_STORAGE_MISMATCH',
        'object-storage content sha mismatch at DB/runtime boundary',
        {
          expected: p.content_sha256,
          actual: r.rows[0].content_sha256,
        }
      );
    }
  }

  function verifyGitRemote(gitArtifact) {
    const p = gitArtifact.payload_json || {};
    const remote = p.remote_url;
    if (!remote || typeof remote !== 'string') {
      throw new BackupRestoreError(
        'GIT_REMOTE_MISSING',
        'git remote backup surface missing remote_url'
      );
    }
    if (/password|token|secret|credential/i.test(remote)) {
      throw new BackupRestoreError(
        'GIT_REMOTE_CREDENTIAL_LEAK',
        'git remote must not embed credentials'
      );
    }
    if (!p.ref || typeof p.ref !== 'string') {
      throw new BackupRestoreError(
        'GIT_PROVENANCE_MISSING',
        'git remote backup surface missing ref provenance'
      );
    }
    if (!isCommitSha(p.commit_sha)) {
      throw new BackupRestoreError(
        'GIT_PROVENANCE_MISSING',
        'git remote backup surface missing commit_sha provenance'
      );
    }
    if (remote !== gitProvenance.remote_url) {
      throw new BackupRestoreError(
        'GIT_PROVENANCE_MISMATCH',
        'git remote_url does not match runtime provenance',
        { expected: gitProvenance.remote_url, actual: remote }
      );
    }
    if (p.ref !== gitProvenance.ref) {
      throw new BackupRestoreError(
        'GIT_PROVENANCE_MISMATCH',
        'git ref does not match runtime provenance',
        { expected: gitProvenance.ref, actual: p.ref }
      );
    }
    if (p.commit_sha.toLowerCase() !== gitProvenance.commit_sha.toLowerCase()) {
      throw new BackupRestoreError(
        'GIT_PROVENANCE_MISMATCH',
        'git commit_sha does not match runtime provenance',
        { expected: gitProvenance.commit_sha, actual: p.commit_sha }
      );
    }
    if (p.remote_name && p.remote_name !== gitProvenance.remote_name) {
      throw new BackupRestoreError(
        'GIT_PROVENANCE_MISMATCH',
        'git remote_name does not match runtime provenance',
        { expected: gitProvenance.remote_name, actual: p.remote_name }
      );
    }
    return p;
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
      const prepared = await withTenantTx(async (tx) => {
        let epoch = backupEpoch;
        if (epoch == null) {
          const latest = await tx.query(
            `SELECT MAX(backup_epoch) AS epoch
               FROM backup_artifacts
              WHERE tenant_id = cur_tenant();`
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
             (rehearsal_id, tenant_id, backup_epoch, status, writers_frozen,
              surfaces_json, pre_restore_fingerprint)
           VALUES ($1, cur_tenant(), $2, 'RUNNING', false, $3::jsonb, $4);`,
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

      await withTenantTx(async (tx) => {
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET writers_frozen = true, recovery_epoch = $2
            WHERE rehearsal_id = $1
              AND tenant_id = cur_tenant();`,
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
        const wipedIndexes = await tx.query(
          `SELECT count(*)::int AS n FROM derived_index_entries
            WHERE tenant_id = cur_tenant();`
        );
        if (wipedIndexes.rows[0].n !== 0) {
          throw new BackupRestoreError(
            'WIPE_FAILED',
            'derived indexes still present after wipe'
          );
        }

        await restorePostgresFromArtifact(tx, prepared.postgresArtifact);
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET postgres_restored = true
            WHERE rehearsal_id = $1
              AND tenant_id = cur_tenant();`,
          [rehearsalId]
        );

        await rebuildDerivedIndexes(tx, prepared.bySurface.get('derived_indexes'));
        await assertDerivedIndexesRebuilt(tx, prepared.bySurface.get('derived_indexes'));
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET derived_indexes_rebuilt = true
            WHERE rehearsal_id = $1
              AND tenant_id = cur_tenant();`,
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
            WHERE rehearsal_id = $1
              AND tenant_id = cur_tenant();`,
          [rehearsalId, postFingerprint]
        );
      });

      await dbos.markReconciled('postgres');
      await dbos.markReconciled('dbos');
      await withTenantTx(async (tx) => {
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET dbos_reconciled = true
            WHERE rehearsal_id = $1
              AND tenant_id = cur_tenant();`,
          [rehearsalId]
        );
      });
      await dbos.markReconciled('providers');
      await withTenantTx(async (tx) => {
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET providers_reconciled = true
            WHERE rehearsal_id = $1
              AND tenant_id = cur_tenant();`,
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

      const success = await withTenantTx(async (tx) => {
        await tx.query(
          `UPDATE backup_rehearsal_runs
              SET writers_reactivated = true,
                  status = 'SUCCESS',
                  completed_at = now()
            WHERE rehearsal_id = $1
              AND tenant_id = cur_tenant();`,
          [rehearsalId]
        );
        const r = await tx.query(
          `SELECT rehearsal_id, backup_epoch, status, writers_frozen,
                  postgres_restored, derived_indexes_rebuilt, dbos_reconciled,
                  providers_reconciled, writers_reactivated,
                  pre_restore_fingerprint, post_restore_fingerprint,
                  recovery_epoch, completed_at
             FROM backup_rehearsal_runs
            WHERE rehearsal_id = $1
              AND tenant_id = cur_tenant();`,
          [rehearsalId]
        );
        return r.rows[0];
      });

      return success;
    } catch (err) {
      try {
        await withTenantTx(async (tx) => {
          await tx.query(
            `UPDATE backup_rehearsal_runs
                SET status = 'FAILED',
                    error_json = $2::jsonb,
                    completed_at = now()
              WHERE rehearsal_id = $1
                AND tenant_id = cur_tenant()
                AND status = 'RUNNING';`,
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
    return assertRestoreRehearsed(db, { trustedTenantId });
  }

  async function seedDurableFixture({
    stateKey = 'backup.fixture',
    value,
    typedProperties,
  } = {}) {
    return withRuntimeTx(async (tx) => {
      const stateId = randomUUID();
      const eventId = randomUUID();
      const dedupe = `backup-fixture-${stateId}`;
      await tx.query(
        `INSERT INTO current_state_records
           (state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
            source_system, as_of, observed_at, verified_at, max_age_seconds, freshness,
            conflict_status, evidence_refs)
         VALUES ($1, cur_tenant(), $2, 'recovery', 'fixture', $3::jsonb, '1',
                 'backup_restore', now(), now(), now(), 3600, 'FRESH',
                 'NONE', '[]'::jsonb);`,
        [stateId, stateKey, JSON.stringify(value ?? { ok: true, marker: stateId })]
      );
      await tx.query(
        `INSERT INTO canonical_events
           (event_id, tenant_id, event_type, source_system, dedupe_key,
            authenticity_status, authenticity_method, content_trust,
            typed_properties, subject_refs, schema_version, materialized_state)
         VALUES ($1, cur_tenant(), 'backup.fixture.seeded', 'backup_restore', $2,
                 'NOT_APPLICABLE', 'fixture', 'TRUSTED_STRUCTURED',
                 $3::jsonb, '["fixture"]'::jsonb, 1, false);`,
        [
          eventId,
          dedupe,
          JSON.stringify(typedProperties ?? { fixture: true, state_key: stateKey }),
        ]
      );
      return { stateId, eventId, dedupe, stateKey };
    });
  }

  return {
    trustedTenantId,
    dbos,
    gitProvenance,
    createBackupSet,
    runRestoreRehearsal,
    latestSuccessfulRehearsal,
    assertRestoreRehearsed: (opts) => assertRestoreRehearsed(db, {
      ...opts,
      trustedTenantId,
    }),
    seedDurableFixture,
    requiredSurfaces: REQUIRED_BACKUP_SURFACES,
  };
}
