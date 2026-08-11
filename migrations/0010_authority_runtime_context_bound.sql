-- 0010_authority_runtime_context_bound.sql
-- Finding 1 (current Codex goal review): cross-tenant authority read bypass.
-- The previous read_authority_state(p_tenant uuid) was SECURITY DEFINER and
-- granted to app_runtime, so a caller could pass another tenant's UUID and
-- read that tenant's authority state. This violates the frozen rule that
-- tenant_id is a non-bypassable boundary and runtime tenant scope comes from
-- trusted transaction-local context.
--
-- Smallest safe repair: the RUNTIME reader derives the tenant EXCLUSIVELY from
-- the trusted transaction-local tenant context (cur_tenant()). app_runtime can
-- no longer select a tenant by argument. Missing tenant context fails closed
-- (no row returned -> caller raises AuthorityUnavailableError).
--
-- The old caller-selected-tenant function is dropped. A bootstrap/internal
-- tenant-specific reader is NOT exposed to app_runtime; bootstrap code reads
-- authority_control directly as the migrator/superuser (RLS does not apply to
-- owners/superusers).

DROP FUNCTION IF EXISTS read_authority_state(uuid);

CREATE OR REPLACE FUNCTION read_authority_state()
  RETURNS TABLE(active_authority boolean, revocation_epoch int, kill_epoch int)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.active_authority, a.revocation_epoch, a.kill_epoch
  FROM authority_control a
  WHERE a.tenant_id = cur_tenant();
$$;

REVOKE ALL ON FUNCTION read_authority_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION read_authority_state() FROM app_runtime;
GRANT EXECUTE ON FUNCTION read_authority_state() TO app_runtime;
