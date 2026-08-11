-- 0011_capability_registry.sql
-- Phase 2: Governed Capability Registry per 06_SYSTEM_CONTRACTS.md Capability.
-- Persistence + RLS only. No live provider connections, connectors, credential
-- broker, or trusted-executor material commit path.

-- Tenant-owned capability rows. tenant_id is the RLS ownership key; the
-- canonical contract field tenant_scope remains a string descriptor.
CREATE TABLE capabilities (
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  capability_id text NOT NULL,
  contract_version int NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  tenant_scope text NOT NULL,
  provider text NOT NULL,
  control_surface text NOT NULL
    CHECK (control_surface IN (
      'api','mcp','cli','dom','browser_agent','computer_use','human'
    )),
  adapter text NOT NULL,
  operation text NOT NULL,
  risk_class text NOT NULL,
  reversibility text NOT NULL
    CHECK (reversibility IN ('reversible','compensatable','irreversible')),
  auth_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Opaque credential reference ONLY. Never store raw provider secrets here.
  credential_ref text,
  provider_idempotency text NOT NULL
    CHECK (provider_idempotency IN ('supported','unsupported','unknown')),
  postcondition_observable boolean NOT NULL,
  preconditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  postcondition_verifier text,
  fallback_routes jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_policy text NOT NULL,
  network_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  timeout_retry_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  receipt_schema text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('active','degraded','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, capability_id),
  CONSTRAINT capabilities_fallback_routes_is_array
    CHECK (jsonb_typeof(fallback_routes) = 'array'),
  CONSTRAINT capabilities_auth_scope_is_object
    CHECK (jsonb_typeof(auth_scope) = 'object'),
  CONSTRAINT capabilities_preconditions_is_object
    CHECK (jsonb_typeof(preconditions) = 'object'),
  CONSTRAINT capabilities_network_scope_is_object
    CHECK (jsonb_typeof(network_scope) = 'object'),
  CONSTRAINT capabilities_timeout_retry_policy_is_object
    CHECK (jsonb_typeof(timeout_retry_policy) = 'object')
);
ALTER TABLE capabilities OWNER TO app_migrator;

-- Normalized same-tenant fallback references for relational integrity.
-- Cross-tenant fallback targets are rejected by the composite FK.
CREATE TABLE capability_fallback_refs (
  tenant_id uuid NOT NULL,
  capability_id text NOT NULL,
  fallback_capability_id text NOT NULL,
  PRIMARY KEY (tenant_id, capability_id, fallback_capability_id),
  FOREIGN KEY (tenant_id, capability_id)
    REFERENCES capabilities(tenant_id, capability_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, fallback_capability_id)
    REFERENCES capabilities(tenant_id, capability_id)
);
ALTER TABLE capability_fallback_refs OWNER TO app_migrator;

ALTER TABLE capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_fallback_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_fallback_refs FORCE ROW LEVEL SECURITY;

CREATE POLICY capabilities_iso ON capabilities
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY capability_fallback_refs_iso ON capability_fallback_refs
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON capabilities, capability_fallback_refs
  TO app_runtime;

-- Contract/version metadata for the Capability machine contract (not granted
-- to app_runtime; migrator/bootstrap only).
INSERT INTO contract_metadata (contract_name, contract_version, git_sha, schema_path)
VALUES ('Capability', 1, NULL, 'docs/master-sot/06_SYSTEM_CONTRACTS.md#Capability');
