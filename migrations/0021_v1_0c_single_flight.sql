-- 0021_v1_0c_single_flight.sql
-- V1.0C write-safe foundation: Agent 0 single-flight + semantic action dedupe.
-- Single active customer-facing decision per
--   tenant_id + subject_ref + routine_id + logical_stage
-- (docs/master-sot/05_PRODUCT_BEHAVIOR.md, 07_AUTHORITY_SECURITY_EXECUTION.md).
-- Business-write autonomy remains DISABLED; this is the concurrency fence only.

CREATE TABLE decision_flights (
  flight_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  subject_ref text NOT NULL,
  routine_id text NOT NULL,
  logical_stage text NOT NULL,
  workflow_id uuid NOT NULL,
  status text NOT NULL
    CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  completed_at timestamptz,
  cancel_reason text
);
ALTER TABLE decision_flights OWNER TO app_migrator;

-- At most one ACTIVE flight for the single-flight key.
CREATE UNIQUE INDEX decision_flights_active_uq
  ON decision_flights (tenant_id, subject_ref, routine_id, logical_stage)
  WHERE status = 'ACTIVE';

CREATE INDEX decision_flights_workflow_idx
  ON decision_flights (tenant_id, workflow_id);

ALTER TABLE decision_flights ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_flights FORCE ROW LEVEL SECURITY;

CREATE POLICY decision_flights_iso ON decision_flights
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON decision_flights TO app_runtime;

-- Semantic action key: independently worded decisions cannot create the same
-- logical customer effect twice (07 Agent 0 concurrency).
CREATE TABLE semantic_action_claims (
  claim_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  subject_ref text NOT NULL,
  semantic_action_key text NOT NULL,
  workflow_id uuid NOT NULL,
  effect_id uuid,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_ref, semantic_action_key)
);
ALTER TABLE semantic_action_claims OWNER TO app_migrator;

ALTER TABLE semantic_action_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_action_claims FORCE ROW LEVEL SECURITY;

CREATE POLICY semantic_action_claims_iso ON semantic_action_claims
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON semantic_action_claims TO app_runtime;
