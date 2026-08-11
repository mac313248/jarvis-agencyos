-- 0013_dbos_durable_workflows.sql
-- F-09: DBOS Transact + Postgres durable workflow state.
-- Schema/role separation per 07_AUTHORITY_SECURITY_EXECUTION.md:
--   AgencyOS control/business schemas/roles remain in public/app_*.
--   DBOS workflow/system state lives in schema dbos with role dbos_runtime.
-- Tenant isolation: PostgreSQL RLS + FORCE RLS + trusted transaction-local
--   tenant context (cur_tenant()), same boundary as AgencyOS business tables.
-- Business-write autonomy remains DISABLED. No Temporal/Restate.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbos_runtime') THEN
    CREATE ROLE dbos_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS dbos AUTHORIZATION app_migrator;
REVOKE ALL ON SCHEMA dbos FROM PUBLIC;
GRANT USAGE ON SCHEMA dbos TO dbos_runtime;
GRANT USAGE ON SCHEMA dbos TO app_runtime;

-- Trusted tenant context helpers for the DBOS runtime role.
GRANT EXECUTE ON FUNCTION set_tenant(uuid), cur_tenant(), require_tenant() TO dbos_runtime;

-- Workflow execution rows (DBOS owns checkpoint/recovery).
CREATE TABLE dbos.workflows (
  workflow_id uuid PRIMARY KEY,
  workflow_name text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  status text NOT NULL
    CHECK (status IN ('PENDING','WAITING','SUCCESS','ERROR','CANCELLED')),
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb,
  error_json jsonb,
  next_function_id int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dbos.workflows OWNER TO app_migrator;

-- Completed step outputs — OAOO: once SUCCESS, never re-executed on recovery.
CREATE TABLE dbos.operation_outputs (
  workflow_id uuid NOT NULL REFERENCES dbos.workflows(workflow_id),
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  function_id int NOT NULL,
  step_id text NOT NULL,
  step_kind text NOT NULL
    CHECK (step_kind IN ('STEP','APPROVAL_WAIT','EXTERNAL','TOOL','LLM')),
  status text NOT NULL
    CHECK (status IN ('SUCCESS','ERROR')),
  output_json jsonb,
  error_json jsonb,
  idempotency_key text,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, function_id),
  UNIQUE (workflow_id, step_id)
);
ALTER TABLE dbos.operation_outputs OWNER TO app_migrator;

-- Human/approval waits that must survive process restart.
CREATE TABLE dbos.approval_waits (
  wait_id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES dbos.workflows(workflow_id),
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  step_id text NOT NULL,
  proposal_id uuid,
  status text NOT NULL
    CHECK (status IN ('WAITING','SIGNALED','CANCELLED')),
  signal_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  signaled_at timestamptz,
  UNIQUE (workflow_id, step_id)
);
ALTER TABLE dbos.approval_waits OWNER TO app_migrator;

ALTER TABLE dbos.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE dbos.workflows FORCE ROW LEVEL SECURITY;
ALTER TABLE dbos.operation_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dbos.operation_outputs FORCE ROW LEVEL SECURITY;
ALTER TABLE dbos.approval_waits ENABLE ROW LEVEL SECURITY;
ALTER TABLE dbos.approval_waits FORCE ROW LEVEL SECURITY;

CREATE POLICY workflows_tenant_iso ON dbos.workflows
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY operation_outputs_tenant_iso ON dbos.operation_outputs
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY approval_waits_tenant_iso ON dbos.approval_waits
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON dbos.workflows TO dbos_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbos.operation_outputs TO dbos_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbos.approval_waits TO dbos_runtime;

-- app_runtime may observe workflow linkage (defense-in-depth reads) but
-- must not mutate DBOS system checkpoints.
GRANT SELECT ON dbos.workflows TO app_runtime;
GRANT SELECT ON dbos.operation_outputs TO app_runtime;
GRANT SELECT ON dbos.approval_waits TO app_runtime;

-- Global PITR/restore writer freeze (#52).
-- Writers stay frozen until Postgres + DBOS + providers are reconciled.
CREATE TABLE recovery_control (
  control_id int PRIMARY KEY DEFAULT 1 CHECK (control_id = 1),
  writers_frozen boolean NOT NULL DEFAULT false,
  recovery_epoch int NOT NULL DEFAULT 0,
  postgres_reconciled boolean NOT NULL DEFAULT false,
  dbos_reconciled boolean NOT NULL DEFAULT false,
  providers_reconciled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE recovery_control OWNER TO app_migrator;

INSERT INTO recovery_control (control_id, writers_frozen, recovery_epoch)
VALUES (1, false, 0)
ON CONFLICT (control_id) DO NOTHING;

-- Not tenant-owned; control-plane only. No RLS (singleton).
GRANT SELECT ON recovery_control TO app_runtime;
GRANT SELECT, UPDATE ON recovery_control TO dbos_runtime;
GRANT SELECT, UPDATE ON recovery_control TO app_migrator;
