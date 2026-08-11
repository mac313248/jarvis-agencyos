-- 0012_effect_ledger.sql
-- Durable local effect ledger for F-08 trusted executor.
-- Supports at-most-once materialization via UNIQUE(idempotency_key) and
-- crash recovery after adapter commit but before receipt completion.
-- Live external provider side effects remain out of scope; ledger tracks the
-- local/fake effect boundary only. Business-write autonomy stays DISABLED.

CREATE TABLE effect_ledger (
  effect_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  idempotency_key text NOT NULL,
  proposal_id uuid NOT NULL REFERENCES action_proposals(proposal_id),
  workflow_id uuid NOT NULL,
  step_id text NOT NULL,
  capability_id text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('PENDING','COMMITTED','COMPLETED','DENIED','FAILED')),
  commit_token text,
  postcondition_status text
    CHECK (postcondition_status IS NULL OR postcondition_status IN (
      'VERIFIED','UNVERIFIED','AMBIGUOUS','FAILED','UNKNOWN'
    )),
  receipt_id uuid,
  outcome text
    CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED','DENIED','FAILED','AMBIGUOUS')),
  error_class text,
  revocation_epoch_at_commit int,
  kill_epoch_at_commit int,
  started_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  completed_at timestamptz,
  UNIQUE (idempotency_key)
);
ALTER TABLE effect_ledger OWNER TO app_migrator;

ALTER TABLE effect_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE effect_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY effect_ledger_iso ON effect_ledger
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON effect_ledger TO app_runtime;
