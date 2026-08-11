-- 0016_f11_memory_secret_gates.sql
-- F-11 bounded repair: database-enforced fail-closed gates.
--
-- Blocker 1: app_runtime must not direct-INSERT into global_durable_memory
-- bypassing the #44 policy (third-party raw / PII-shaped payloads that omit
-- raw_tenant_data). Controlled path: ingest_global_durable_memory().
--
-- Blocker 2: connectors.auth_scope / network_scope must reject nested
-- secret-bearing keys and inline secret-shaped values at any depth.
--
-- Business-write autonomy remains DISABLED. Writer connectors remain DISABLED.

-- ---------------------------------------------------------------------------
-- Recursive secret scanner for JSONB metadata (auth_scope / network_scope).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jsonb_contains_forbidden_secret(j jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  k text;
  v jsonb;
  forbidden text[] := ARRAY[
    'password', 'api_key', 'apikey', 'secret', 'token', 'access_token',
    'refresh_token', 'client_secret', 'private_key', 'bearer'
  ];
BEGIN
  IF j IS NULL THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(j) = 'object' THEN
    FOR k, v IN SELECT key, value FROM jsonb_each(j) LOOP
      IF lower(k) = ANY (forbidden) THEN
        RETURN true;
      END IF;
      IF jsonb_contains_forbidden_secret(v) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;

  IF jsonb_typeof(j) = 'array' THEN
    FOR v IN SELECT value FROM jsonb_array_elements(j) LOOP
      IF jsonb_contains_forbidden_secret(v) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;

  IF jsonb_typeof(j) = 'string' THEN
    IF (j #>> '{}') ~* '^(sk-|Bearer |-----BEGIN )' THEN
      RETURN true;
    END IF;
    RETURN false;
  END IF;

  RETURN false;
END;
$$;

ALTER FUNCTION jsonb_contains_forbidden_secret(jsonb) OWNER TO app_migrator;
REVOKE ALL ON FUNCTION jsonb_contains_forbidden_secret(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jsonb_contains_forbidden_secret(jsonb) TO app_runtime;

ALTER TABLE connectors
  DROP CONSTRAINT IF EXISTS connectors_auth_scope_no_secrets,
  DROP CONSTRAINT IF EXISTS connectors_network_scope_no_secrets;

ALTER TABLE connectors
  ADD CONSTRAINT connectors_auth_scope_no_secrets
    CHECK (NOT jsonb_contains_forbidden_secret(auth_scope)),
  ADD CONSTRAINT connectors_network_scope_no_secrets
    CHECK (NOT jsonb_contains_forbidden_secret(network_scope));

-- ---------------------------------------------------------------------------
-- Global durable memory: raw/PII-shaped payload detector (mirrors app gate).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION global_memory_payload_is_raw(payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RETURN true;
  END IF;
  IF payload ? 'raw_tenant_data'
     AND (payload->>'raw_tenant_data') IN ('true', 't', '1') THEN
    RETURN true;
  END IF;
  IF payload ? 'raw' AND (payload->>'raw') IN ('true', 't', '1') THEN
    RETURN true;
  END IF;
  IF (payload->>'kind') = 'raw_connector_read' THEN
    RETURN true;
  END IF;
  IF payload ? 'pii_raw' AND payload->'pii_raw' IS NOT NULL
     AND jsonb_typeof(payload->'pii_raw') <> 'null' THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(payload->'customer_email') = 'string' THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(payload->'customer_phone') = 'string' THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(payload->'full_name') = 'string' THEN
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

ALTER FUNCTION global_memory_payload_is_raw(jsonb) OWNER TO app_migrator;
REVOKE ALL ON FUNCTION global_memory_payload_is_raw(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION global_memory_payload_is_raw(jsonb) TO app_runtime;

-- Table-level fail-closed: reject raw/PII-shaped payloads even without the flag.
ALTER TABLE global_durable_memory
  DROP CONSTRAINT IF EXISTS global_durable_memory_no_raw_shaped;

ALTER TABLE global_durable_memory
  ADD CONSTRAINT global_durable_memory_no_raw_shaped
    CHECK (NOT global_memory_payload_is_raw(payload));

-- Third-party rows must be explicitly permitted de-identified/ops metadata.
ALTER TABLE global_durable_memory
  DROP CONSTRAINT IF EXISTS global_durable_memory_third_party_permitted;

ALTER TABLE global_durable_memory
  ADD CONSTRAINT global_durable_memory_third_party_permitted
    CHECK (
      source_confidentiality_class <> 'THIRD_PARTY_ISOLATED'
      OR (
        (payload->>'permitted') = 'true'
        AND (
          memory_class <> 'DEIDENTIFIED_AGGREGATE'
          OR (payload->>'deidentified') = 'true'
        )
      )
    );

-- ---------------------------------------------------------------------------
-- Controlled ingest path: revoke direct INSERT; SECURITY DEFINER enforces #44.
-- ---------------------------------------------------------------------------
REVOKE INSERT ON global_durable_memory FROM app_runtime;
-- SELECT retained for verification / reads.
GRANT SELECT ON global_durable_memory TO app_runtime;

CREATE OR REPLACE FUNCTION ingest_global_durable_memory(
  p_memory_id uuid,
  p_memory_class text,
  p_source_confidentiality_class text,
  p_source_tenant_id uuid,
  p_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_memory_id IS NULL THEN
    RAISE EXCEPTION 'memory_id required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_memory_class IS NULL
     OR p_memory_class NOT IN ('DEIDENTIFIED_AGGREGATE', 'OPERATIONAL_METADATA') THEN
    RAISE EXCEPTION 'INVALID_MEMORY_CLASS: memory_class must be DEIDENTIFIED_AGGREGATE|OPERATIONAL_METADATA'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_source_confidentiality_class IS NULL
     OR p_source_confidentiality_class NOT IN (
       'FIRST_PARTY_PORTFOLIO', 'THIRD_PARTY_ISOLATED'
     ) THEN
    RAISE EXCEPTION 'UNKNOWN_CONFIDENTIALITY_CLASS: unknown confidentiality class: %',
      p_source_confidentiality_class
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'RAW_TENANT_DATA_FORBIDDEN: raw tenant data cannot enter global durable memory'
      USING ERRCODE = 'check_violation';
  END IF;

  IF global_memory_payload_is_raw(p_payload) THEN
    RAISE EXCEPTION 'RAW_TENANT_DATA_FORBIDDEN: raw tenant data cannot enter global durable memory'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_source_confidentiality_class = 'THIRD_PARTY_ISOLATED' THEN
    IF (p_payload->>'permitted') IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'THIRD_PARTY_NOT_PERMITTED: third-party global memory requires explicit permitted=true aggregate'
        USING ERRCODE = 'check_violation';
    END IF;
    IF p_memory_class = 'DEIDENTIFIED_AGGREGATE'
       AND (p_payload->>'deidentified') IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'THIRD_PARTY_NOT_DEIDENTIFIED: third-party aggregate must be deidentified=true'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO global_durable_memory (
    memory_id, memory_class, source_confidentiality_class,
    source_tenant_id, payload
  ) VALUES (
    p_memory_id, p_memory_class, p_source_confidentiality_class,
    p_source_tenant_id, p_payload
  );

  RETURN p_memory_id;
END;
$$;

ALTER FUNCTION ingest_global_durable_memory(uuid, text, text, uuid, jsonb)
  OWNER TO app_migrator;
REVOKE ALL ON FUNCTION ingest_global_durable_memory(uuid, text, text, uuid, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_global_durable_memory(uuid, text, text, uuid, jsonb)
  TO app_runtime;
