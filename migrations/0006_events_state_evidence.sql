-- 0006_events_state_evidence.sql
-- CanonicalEvent, CurrentStateRecord, evidence references per 06.
-- Inbound authenticity boundary: FAILED/UNKNOWN authenticity on an event
-- type requiring provider authentication cannot materialize canonical
-- business state.

CREATE TABLE evidence_refs (
  evidence_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  storage_uri text NOT NULL,
  content_type text,
  content_sha256 text,
  stored_at timestamptz NOT NULL DEFAULT now(),
  deletable boolean NOT NULL DEFAULT true
);
ALTER TABLE evidence_refs OWNER TO app_migrator;

CREATE TABLE canonical_events (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  event_type text NOT NULL,
  source_system text NOT NULL,
  source_connection_id uuid,
  source_event_id text,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  subject_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  typed_properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL,
  evidence_ref uuid REFERENCES evidence_refs(evidence_id),
  schema_version int NOT NULL DEFAULT 1,
  authenticity_status text NOT NULL
    CHECK (authenticity_status IN ('VERIFIED','NOT_APPLICABLE','FAILED','UNKNOWN')),
  authenticity_method text,
  content_trust text NOT NULL
    CHECK (content_trust IN ('TRUSTED_STRUCTURED','UNTRUSTED_PAYLOAD')),
  verification_evidence_ref uuid,
  materialized_state boolean NOT NULL DEFAULT false,
  UNIQUE (dedupe_key)
);
ALTER TABLE canonical_events OWNER TO app_migrator;

CREATE TABLE current_state_records (
  state_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  state_key text NOT NULL,
  domain text NOT NULL,
  subject_ref text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_version text NOT NULL,
  source_system text NOT NULL,
  as_of timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  max_age_seconds int NOT NULL,
  freshness text NOT NULL
    CHECK (freshness IN ('FRESH','AGING','STALE','OFFLINE','CONFLICTED','UNKNOWN')),
  conflict_status text NOT NULL DEFAULT 'NONE'
    CHECK (conflict_status IN ('NONE','PENDING_LOCAL_EFFECT','SOURCE_CONFLICT','UNKNOWN')),
  last_event_id uuid,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (tenant_id, state_key)
);
ALTER TABLE current_state_records OWNER TO app_migrator;

ALTER TABLE evidence_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE canonical_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_events FORCE ROW LEVEL SECURITY;
ALTER TABLE current_state_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE current_state_records FORCE ROW LEVEL SECURITY;

CREATE POLICY evidence_refs_iso ON evidence_refs
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY canonical_events_iso ON canonical_events
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY current_state_records_iso ON current_state_records
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON evidence_refs, canonical_events, current_state_records
  TO app_runtime;
