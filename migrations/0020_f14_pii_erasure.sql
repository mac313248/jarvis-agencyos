-- 0020_f14_pii_erasure.sql
-- F-14 Security / privacy acceptance suite.
-- Bound to:
--   12_ACCEPTANCE_AND_IMPLEMENTATION.md#Privacy-deletion (#40, #41, #43)
--   07_AUTHORITY_SECURITY_EXECUTION.md#PII-erasure
--   06_SYSTEM_CONTRACTS.md PII subject reference
--
-- Raw customer PII lives in deletable tenant-scoped stores.
-- Derived vectors/FTS/cache/summaries retain lineage to subject_ref and must
-- be withdrawn on valid deletion. Only non-identifying audit proof remains.
-- Business-write autonomy remains DISABLED.

-- Canonical deletable identifiable customer data.
CREATE TABLE pii_store_rows (
  pii_row_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  subject_ref uuid NOT NULL REFERENCES pii_subjects(subject_ref),
  email text,
  full_name text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pii_store_rows OWNER TO app_migrator;

CREATE INDEX pii_store_rows_subject_idx
  ON pii_store_rows (tenant_id, subject_ref);

ALTER TABLE pii_store_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii_store_rows FORCE ROW LEVEL SECURITY;

CREATE POLICY pii_store_rows_iso ON pii_store_rows
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

-- Rebuildable embedding stand-in (pgvector content surface for erasure).
CREATE TABLE subject_embeddings (
  embedding_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  subject_ref uuid NOT NULL REFERENCES pii_subjects(subject_ref),
  source_record_ref text NOT NULL,
  content_text text NOT NULL,
  embedding jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subject_embeddings_embedding_is_array
    CHECK (jsonb_typeof(embedding) = 'array')
);
ALTER TABLE subject_embeddings OWNER TO app_migrator;

CREATE INDEX subject_embeddings_subject_idx
  ON subject_embeddings (tenant_id, subject_ref);

ALTER TABLE subject_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_embeddings FORCE ROW LEVEL SECURITY;

CREATE POLICY subject_embeddings_iso ON subject_embeddings
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

-- FTS document stand-in (searchable text that may contain PII).
CREATE TABLE subject_fts_documents (
  fts_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  subject_ref uuid NOT NULL REFERENCES pii_subjects(subject_ref),
  source_record_ref text NOT NULL,
  document_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE subject_fts_documents OWNER TO app_migrator;

CREATE INDEX subject_fts_documents_subject_idx
  ON subject_fts_documents (tenant_id, subject_ref);

ALTER TABLE subject_fts_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_fts_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY subject_fts_documents_iso ON subject_fts_documents
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

-- Tenant-scoped subject cache (may hold identifiable values).
CREATE TABLE subject_cache_entries (
  cache_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  subject_ref uuid NOT NULL REFERENCES pii_subjects(subject_ref),
  cache_key text NOT NULL,
  cache_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cache_key),
  CONSTRAINT subject_cache_entries_value_is_object
    CHECK (jsonb_typeof(cache_value) = 'object')
);
ALTER TABLE subject_cache_entries OWNER TO app_migrator;

CREATE INDEX subject_cache_entries_subject_idx
  ON subject_cache_entries (tenant_id, subject_ref);

ALTER TABLE subject_cache_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_cache_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY subject_cache_entries_iso ON subject_cache_entries
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

-- Derived summaries/procedures that may expose a subject.
CREATE TABLE subject_derived_summaries (
  summary_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  subject_ref uuid NOT NULL REFERENCES pii_subjects(subject_ref),
  source_record_ref text NOT NULL,
  summary_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE subject_derived_summaries OWNER TO app_migrator;

CREATE INDEX subject_derived_summaries_subject_idx
  ON subject_derived_summaries (tenant_id, subject_ref);

ALTER TABLE subject_derived_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_derived_summaries FORCE ROW LEVEL SECURITY;

CREATE POLICY subject_derived_summaries_iso ON subject_derived_summaries
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

-- Non-identifying audit tombstone after valid customer deletion.
-- Opaque subject_ref + surface counts only — no raw PII columns.
CREATE TABLE deletion_audit_tombstones (
  tombstone_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  subject_ref uuid NOT NULL REFERENCES pii_subjects(subject_ref),
  request_ref text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  surfaces_withdrawn jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT deletion_audit_tombstones_surfaces_is_object
    CHECK (jsonb_typeof(surfaces_withdrawn) = 'object'),
  UNIQUE (tenant_id, subject_ref, request_ref)
);
ALTER TABLE deletion_audit_tombstones OWNER TO app_migrator;

CREATE INDEX deletion_audit_tombstones_subject_idx
  ON deletion_audit_tombstones (tenant_id, subject_ref);

ALTER TABLE deletion_audit_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_audit_tombstones FORCE ROW LEVEL SECURITY;

CREATE POLICY deletion_audit_tombstones_iso ON deletion_audit_tombstones
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON pii_store_rows,
     subject_embeddings,
     subject_fts_documents,
     subject_cache_entries,
     subject_derived_summaries
  TO app_runtime;

GRANT SELECT, INSERT
  ON deletion_audit_tombstones
  TO app_runtime;

INSERT INTO contract_metadata (contract_name, contract_version, git_sha, schema_path)
VALUES (
  'PiiErasureDeletion',
  1,
  NULL,
  'docs/master-sot/07_AUTHORITY_SECURITY_EXECUTION.md#PII-erasure+12_ACCEPTANCE_AND_IMPLEMENTATION.md#Privacy-deletion'
);
