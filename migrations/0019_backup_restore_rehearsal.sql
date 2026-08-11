-- 0019_backup_restore_rehearsal.sql
-- F-13: Backup / restore rehearsal (acceptance #53).
-- Bound to 10_OBSERVABILITY_RECOVERY.md Backups + PITR sequence and
-- 12_ACCEPTANCE_AND_IMPLEMENTATION.md#Recovery (#53).
--
-- Required backup surfaces (SOT):
--   Postgres PITR/continuous recovery;
--   object-storage versioning/retention;
--   Git remote;
--   rebuildable pgvector/FTS.
--
-- "Backup is not proven until restore is tested."
-- Stop condition: unrehearsed restore.
-- Business-write autonomy remains DISABLED.
--
-- Tenant isolation (01_ARCHITECTURE_LOCKS.md): backup_artifacts and
-- backup_rehearsal_runs are tenant-owned — RLS + FORCE RLS; backup_epoch
-- cannot cross tenants.

-- Inventory of backup artifacts per required surface (tenant-scoped).
CREATE TABLE backup_artifacts (
  artifact_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  surface text NOT NULL
    CHECK (surface IN (
      'postgres_pitr',
      'object_storage',
      'git_remote',
      'derived_indexes'
    )),
  backup_epoch int NOT NULL,
  content_sha256 text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_artifacts_payload_is_object
    CHECK (jsonb_typeof(payload_json) = 'object'),
  UNIQUE (tenant_id, surface, backup_epoch)
);
ALTER TABLE backup_artifacts OWNER TO app_migrator;

CREATE INDEX backup_artifacts_tenant_surface_epoch_idx
  ON backup_artifacts (tenant_id, surface, backup_epoch DESC);

ALTER TABLE backup_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY backup_artifacts_iso ON backup_artifacts
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

-- Proof that a restore was actually rehearsed (not merely claimed).
CREATE TABLE backup_rehearsal_runs (
  rehearsal_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  backup_epoch int NOT NULL,
  status text NOT NULL
    CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED')),
  writers_frozen boolean NOT NULL DEFAULT false,
  postgres_restored boolean NOT NULL DEFAULT false,
  derived_indexes_rebuilt boolean NOT NULL DEFAULT false,
  dbos_reconciled boolean NOT NULL DEFAULT false,
  providers_reconciled boolean NOT NULL DEFAULT false,
  writers_reactivated boolean NOT NULL DEFAULT false,
  pre_restore_fingerprint text,
  post_restore_fingerprint text,
  recovery_epoch int,
  surfaces_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_json jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT backup_rehearsal_surfaces_is_array
    CHECK (jsonb_typeof(surfaces_json) = 'array'),
  -- Success requires an actual restore that matched fingerprints.
  CONSTRAINT backup_rehearsal_success_requires_proof
    CHECK (
      status <> 'SUCCESS'
      OR (
        postgres_restored = true
        AND derived_indexes_rebuilt = true
        AND dbos_reconciled = true
        AND providers_reconciled = true
        AND writers_reactivated = true
        AND pre_restore_fingerprint IS NOT NULL
        AND post_restore_fingerprint IS NOT NULL
        AND pre_restore_fingerprint = post_restore_fingerprint
        AND completed_at IS NOT NULL
      )
    )
);
ALTER TABLE backup_rehearsal_runs OWNER TO app_migrator;

CREATE INDEX backup_rehearsal_runs_tenant_epoch_idx
  ON backup_rehearsal_runs (tenant_id, backup_epoch DESC);

ALTER TABLE backup_rehearsal_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_rehearsal_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY backup_rehearsal_runs_iso ON backup_rehearsal_runs
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

-- Rebuildable derived index ledger (pgvector/FTS stand-ins for foundation).
CREATE TABLE derived_index_entries (
  index_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  index_kind text NOT NULL
    CHECK (index_kind IN ('pgvector', 'fts')),
  source_key text NOT NULL,
  content_sha256 text NOT NULL,
  rebuilt_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, index_kind, source_key)
);
ALTER TABLE derived_index_entries OWNER TO app_migrator;

ALTER TABLE derived_index_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE derived_index_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY derived_index_entries_iso ON derived_index_entries
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

-- Object-storage versioning/retention stand-in for rehearsal (tenant-scoped).
CREATE TABLE object_storage_versions (
  version_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  bucket_key text NOT NULL,
  object_key text NOT NULL,
  version_number int NOT NULL,
  content_sha256 text NOT NULL,
  retained boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bucket_key, object_key, version_number)
);
ALTER TABLE object_storage_versions OWNER TO app_migrator;

ALTER TABLE object_storage_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_storage_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY object_storage_versions_iso ON object_storage_versions
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE ON backup_artifacts, backup_rehearsal_runs TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON derived_index_entries TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON object_storage_versions TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON backup_artifacts, backup_rehearsal_runs TO dbos_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON object_storage_versions TO dbos_runtime;

INSERT INTO contract_metadata (contract_name, contract_version, git_sha, schema_path)
VALUES (
  'BackupRestoreRehearsal',
  1,
  NULL,
  'docs/master-sot/10_OBSERVABILITY_RECOVERY.md#Backups+12_ACCEPTANCE_AND_IMPLEMENTATION.md#Recovery'
);
