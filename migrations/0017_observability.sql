-- 0017_observability.sql
-- F-12 Observability: execution traces, receipt↔trace linkage, attention items.
-- Bound to 10_OBSERVABILITY_RECOVERY.md and
-- 01_ARCHITECTURE_LOCKS.md#Non-silenceable-classes.
--
-- Non-silenceable classes cannot be reduced to SILENCE.
-- Same unresolved attention state_hash must not repeatedly notify.
-- Business-write autonomy remains DISABLED.

CREATE TABLE execution_traces (
  trace_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  workflow_id uuid,
  root_span text NOT NULL DEFAULT 'execution',
  parent_trace_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','closed','failed')),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT execution_traces_attributes_is_object
    CHECK (jsonb_typeof(attributes) = 'object')
);
ALTER TABLE execution_traces OWNER TO app_migrator;

CREATE TABLE attention_items (
  attention_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  condition_key text NOT NULL,
  state_hash text NOT NULL,
  severity text NOT NULL
    CHECK (severity IN ('INFO','WARNING','HIGH','CRITICAL')),
  owner_action_required boolean NOT NULL DEFAULT true,
  event_class text NOT NULL,
  non_silenceable boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acked','snoozed','resolved')),
  first_opened_at timestamptz NOT NULL DEFAULT now(),
  last_material_change_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  notify_count int NOT NULL DEFAULT 0,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  receipt_id uuid,
  trace_id uuid,
  CONSTRAINT attention_items_source_refs_is_array
    CHECK (jsonb_typeof(source_refs) = 'array'),
  CONSTRAINT attention_items_evidence_refs_is_array
    CHECK (jsonb_typeof(evidence_refs) = 'array'),
  -- One unresolved attention row per tenant condition key.
  CONSTRAINT attention_items_open_condition_unique
    UNIQUE (tenant_id, condition_key)
);
ALTER TABLE attention_items OWNER TO app_migrator;

-- DB stop-gate: non-silenceable attention rows cannot be marked resolved via a
-- "silenced" severity/status escape hatch that drops owner visibility while open.
ALTER TABLE attention_items
  ADD CONSTRAINT attention_items_non_silenceable_visible
  CHECK (
    NOT (non_silenceable = true AND status = 'open' AND severity = 'INFO' AND owner_action_required = false)
  );

ALTER TABLE execution_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_traces FORCE ROW LEVEL SECURITY;
ALTER TABLE attention_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE attention_items FORCE ROW LEVEL SECURITY;

CREATE POLICY execution_traces_iso ON execution_traces
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY attention_items_iso ON attention_items
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON execution_traces, attention_items TO app_runtime;

INSERT INTO contract_metadata (contract_name, contract_version, git_sha, schema_path)
VALUES (
  'AttentionItem',
  1,
  NULL,
  'docs/master-sot/06_SYSTEM_CONTRACTS.md#AttentionItem+01_ARCHITECTURE_LOCKS.md#Non-silenceable-classes'
);
