-- 0014_dbos_tenant_rls_forward.sql
-- Forward repair for F-09 databases that applied pre-RLS migration 0013.
-- The migration runner skips recorded IDs, so in-place edits to 0013 never
-- reach existing clusters. This additive migration is idempotent on fresh
-- installs that already received tenant columns/RLS via current 0013.
-- Non-destructive: no DROP TABLE / truncate / cluster reset.

GRANT EXECUTE ON FUNCTION set_tenant(uuid), cur_tenant(), require_tenant() TO dbos_runtime;

-- Tenant column on operation_outputs (missing on pre-repair 0013).
ALTER TABLE dbos.operation_outputs
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(tenant_id);
UPDATE dbos.operation_outputs oo
   SET tenant_id = w.tenant_id
  FROM dbos.workflows w
 WHERE oo.workflow_id = w.workflow_id
   AND oo.tenant_id IS NULL
   AND w.tenant_id IS NOT NULL;

-- Tenant column on approval_waits (missing on pre-repair 0013).
ALTER TABLE dbos.approval_waits
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(tenant_id);
UPDATE dbos.approval_waits aw
   SET tenant_id = w.tenant_id
  FROM dbos.workflows w
 WHERE aw.workflow_id = w.workflow_id
   AND aw.tenant_id IS NULL
   AND w.tenant_id IS NOT NULL;

-- Effect-binding columns / check expansions used by EXTERNAL/TOOL/LLM steps.
ALTER TABLE dbos.operation_outputs
  ADD COLUMN IF NOT EXISTS idempotency_key text;

DO $$
BEGIN
  -- workflows.tenant_id: tighten only when safe (no NULL tenants remain).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'dbos' AND table_name = 'workflows' AND column_name = 'tenant_id'
  ) AND NOT EXISTS (SELECT 1 FROM dbos.workflows WHERE tenant_id IS NULL) THEN
    BEGIN
      ALTER TABLE dbos.workflows ALTER COLUMN tenant_id SET NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END;
    BEGIN
      ALTER TABLE dbos.workflows
        ADD CONSTRAINT workflows_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM dbos.operation_outputs WHERE tenant_id IS NULL) THEN
    BEGIN
      ALTER TABLE dbos.operation_outputs ALTER COLUMN tenant_id SET NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM dbos.approval_waits WHERE tenant_id IS NULL) THEN
    BEGIN
      ALTER TABLE dbos.approval_waits ALTER COLUMN tenant_id SET NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
END $$;

-- Replace step_kind / status checks to include effect-bound + recoverable statuses.
ALTER TABLE dbos.operation_outputs DROP CONSTRAINT IF EXISTS operation_outputs_step_kind_check;
ALTER TABLE dbos.operation_outputs
  ADD CONSTRAINT operation_outputs_step_kind_check
  CHECK (step_kind IN ('STEP','APPROVAL_WAIT','EXTERNAL','TOOL','LLM'));

ALTER TABLE dbos.operation_outputs DROP CONSTRAINT IF EXISTS operation_outputs_status_check;
ALTER TABLE dbos.operation_outputs
  ADD CONSTRAINT operation_outputs_status_check
  CHECK (status IN ('SUCCESS','ERROR','AMBIGUOUS','UNKNOWN'));

-- RLS + FORCE RLS + tenant policies (no-op-safe via drop/create).
ALTER TABLE dbos.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE dbos.workflows FORCE ROW LEVEL SECURITY;
ALTER TABLE dbos.operation_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dbos.operation_outputs FORCE ROW LEVEL SECURITY;
ALTER TABLE dbos.approval_waits ENABLE ROW LEVEL SECURITY;
ALTER TABLE dbos.approval_waits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflows_tenant_iso ON dbos.workflows;
CREATE POLICY workflows_tenant_iso ON dbos.workflows
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

DROP POLICY IF EXISTS operation_outputs_tenant_iso ON dbos.operation_outputs;
CREATE POLICY operation_outputs_tenant_iso ON dbos.operation_outputs
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

DROP POLICY IF EXISTS approval_waits_tenant_iso ON dbos.approval_waits;
CREATE POLICY approval_waits_tenant_iso ON dbos.approval_waits
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
