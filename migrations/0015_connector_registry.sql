-- 0015_connector_registry.sql
-- F-11: Connector registry + opaque credential-broker references.
-- Bound to 06_SYSTEM_CONTRACTS.md#Capability and
-- 07_AUTHORITY_SECURITY_EXECUTION.md#Credential-architecture.
--
-- Read-only adapters only. Writer connectors remain DISABLED.
-- Raw provider secrets must NEVER appear in this registry — opaque refs only.
-- Business-write autonomy remains DISABLED.

-- Tenant-owned connector rows. tenant_id is the RLS ownership key.
CREATE TABLE connectors (
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  connector_id text NOT NULL,
  contract_version int NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  provider text NOT NULL,
  control_surface text NOT NULL
    CHECK (control_surface IN (
      'api','mcp','cli','dom','browser_agent','computer_use','human'
    )),
  adapter text NOT NULL,
  -- F-11: only read_only may be persisted/enabled. Writer modes are rejected.
  access_mode text NOT NULL
    CHECK (access_mode IN ('read_only')),
  capability_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Opaque credential-broker reference ONLY. Never store raw provider secrets.
  credential_broker_ref text,
  -- Opaque authenticity verification method/public-key REFERENCE (07 inbound).
  authenticity_verification_ref text,
  auth_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  network_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL
    CHECK (status IN ('active','degraded','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id),
  CONSTRAINT connectors_capability_ids_is_array
    CHECK (jsonb_typeof(capability_ids) = 'array'),
  CONSTRAINT connectors_auth_scope_is_object
    CHECK (jsonb_typeof(auth_scope) = 'object'),
  CONSTRAINT connectors_network_scope_is_object
    CHECK (jsonb_typeof(network_scope) = 'object')
);
ALTER TABLE connectors OWNER TO app_migrator;

ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors FORCE ROW LEVEL SECURITY;

CREATE POLICY connectors_iso ON connectors
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON connectors TO app_runtime;

-- Global durable memory: ONLY permitted de-identified / operational metadata.
-- Raw third-party tenant payloads are forbidden (acceptance #44).
-- Not tenant-owned; not granted to app_runtime for arbitrary writes —
-- ingestion goes through the durable-memory policy gate.
CREATE TABLE global_durable_memory (
  memory_id uuid PRIMARY KEY,
  memory_class text NOT NULL
    CHECK (memory_class IN ('DEIDENTIFIED_AGGREGATE', 'OPERATIONAL_METADATA')),
  source_confidentiality_class text NOT NULL
    CHECK (source_confidentiality_class IN (
      'FIRST_PARTY_PORTFOLIO', 'THIRD_PARTY_ISOLATED'
    )),
  source_tenant_id uuid,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT global_durable_memory_payload_is_object
    CHECK (jsonb_typeof(payload) = 'object'),
  -- Hard stop: third-party sources may never mark payload as raw tenant data.
  CONSTRAINT global_durable_memory_no_raw_flag
    CHECK (NOT (payload ? 'raw_tenant_data' AND (payload->>'raw_tenant_data') = 'true'))
);
ALTER TABLE global_durable_memory OWNER TO app_migrator;

-- Runtime may SELECT for verification; INSERT only via controlled policy path
-- that still goes through application gate. Direct app_runtime INSERT is
-- granted so tests can prove CHECK constraints, but application code must
-- refuse third-party raw writes before reaching SQL.
GRANT SELECT, INSERT ON global_durable_memory TO app_runtime;

INSERT INTO contract_metadata (contract_name, contract_version, git_sha, schema_path)
VALUES (
  'Connector',
  1,
  NULL,
  'docs/master-sot/06_SYSTEM_CONTRACTS.md#Capability+07_AUTHORITY_SECURITY_EXECUTION.md#Credential-architecture'
);
