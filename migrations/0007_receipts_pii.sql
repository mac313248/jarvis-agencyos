-- 0007_receipts_pii.sql
-- ExecutionReceipt + PII subject reference per 06.
-- Receipts use opaque subject_ref; raw deletable customer PII is NOT stored
-- in immutable receipt/audit structures. A future deletion removes the
-- identifiable pii_store row but leaves the non-identifying receipt.

CREATE TABLE pii_subjects (
  subject_ref uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  pii_store_ref text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','deleted','legal_hold')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
ALTER TABLE pii_subjects OWNER TO app_migrator;

CREATE TABLE execution_receipts (
  receipt_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  workflow_id uuid NOT NULL,
  step_id text NOT NULL,
  actor text NOT NULL,
  capability_id text NOT NULL,
  provider text NOT NULL,
  operation text NOT NULL,
  target_ref text NOT NULL,
  subject_ref uuid REFERENCES pii_subjects(subject_ref),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  precondition_snapshot_ref text,
  authority_decision_ref uuid,
  approval_ref uuid,
  revocation_epoch_at_commit int NOT NULL,
  kill_epoch_at_commit int NOT NULL,
  started_at timestamptz NOT NULL,
  committed_at timestamptz,
  provider_request_id text,
  raw_evidence_ref uuid,
  postcondition_verifier text,
  verification_status text NOT NULL
    CHECK (verification_status IN ('VERIFIED','UNVERIFIED','AMBIGUOUS','FAILED')),
  observed_external_version text,
  state_delta_ref text,
  error_class text,
  retry_count int NOT NULL DEFAULT 0,
  trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);
ALTER TABLE execution_receipts OWNER TO app_migrator;

ALTER TABLE pii_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii_subjects FORCE ROW LEVEL SECURITY;
ALTER TABLE execution_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY pii_subjects_iso ON pii_subjects
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY execution_receipts_iso ON execution_receipts
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON pii_subjects, execution_receipts TO app_runtime;
