-- 0008_kill_authority_epoch.sql
-- Authority/kill control primitives per 07_AUTHORITY_SECURITY_EXECUTION.md.
-- Fail-closed: if fresh authority/kill state cannot be obtained, material
-- writes are denied. Epochs are re-read immediately before commit and
-- recorded in ExecutionReceipt (revocation_epoch_at_commit / kill_epoch_at_commit).
-- No live business-effect path is created here.

CREATE TABLE authority_control (
  control_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  active_authority boolean NOT NULL DEFAULT true,
  revocation_epoch int NOT NULL DEFAULT 0,
  kill_epoch int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);
ALTER TABLE authority_control OWNER TO app_migrator;

ALTER TABLE authority_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE authority_control FORCE ROW LEVEL SECURITY;

CREATE POLICY authority_control_iso ON authority_control
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON authority_control TO app_runtime;

-- Fresh-state reader. Returns NULL if no row exists (fail-closed signal).
CREATE OR REPLACE FUNCTION read_authority_state(p_tenant uuid)
  RETURNS TABLE(active_authority boolean, revocation_epoch int, kill_epoch int)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.active_authority, a.revocation_epoch, a.kill_epoch
  FROM authority_control a
  WHERE a.tenant_id = p_tenant;
$$;
REVOKE ALL ON FUNCTION read_authority_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_authority_state(uuid) TO app_runtime;
