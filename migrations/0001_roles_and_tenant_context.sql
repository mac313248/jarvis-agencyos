-- 0001_roles_and_tenant_context.sql
-- Privileged migration/ownership roles vs least-privilege runtime role.
-- The runtime role (app_runtime) is the ONLY role used for live queries.
-- It is: not superuser, no BYPASSRLS, not a table owner.
-- The migrator role owns schema objects and runs DDL; it is also not superuser
-- and has no BYPASSRLS. (Bootstrap as superuser creates these roles.)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- Trusted transaction-local tenant context.
-- set_config(..., true) is TRANSACTION-LOCAL: the value is dropped on
-- COMMIT/ROLLBACK, so it cannot survive connection check-in/check-out in a
-- pool. Missing/invalid tenant context therefore fails closed (NULL tenant).
CREATE OR REPLACE FUNCTION set_tenant(p_tenant uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT set_config('app.tenant_id', p_tenant::text, true);
$$;

CREATE OR REPLACE FUNCTION cur_tenant() RETURNS uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

-- A guard that fails closed if no tenant context is set. Useful for inserts
-- that must carry tenant_id from trusted context.
CREATE OR REPLACE FUNCTION require_tenant() RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE t uuid;
BEGIN
  t := cur_tenant();
  IF t IS NULL THEN
    RAISE EXCEPTION 'missing tenant context: refused (fail-closed)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN t;
END;
$$;

REVOKE ALL ON FUNCTION set_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION cur_tenant() FROM PUBLIC;
REVOKE ALL ON FUNCTION require_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tenant(uuid), cur_tenant(), require_tenant() TO app_runtime;
