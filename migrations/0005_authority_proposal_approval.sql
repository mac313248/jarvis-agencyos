-- 0005_authority_proposal_approval.sql
-- AuthorityGrant, ActionProposal, ApprovalDecision, PolicyDecision per 06.
-- All tenant-owned with RLS + FORCE RLS.

CREATE TABLE authority_grants (
  grant_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  principal text NOT NULL,
  capability_action_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  resource_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_ceiling text,
  spend_cap numeric,
  commitment_cap jsonb,
  approval_mode text,
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  issued_by text NOT NULL,
  policy_version text NOT NULL,
  revocation_epoch int NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('active','expired','revoked','superseded')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE authority_grants OWNER TO app_migrator;

CREATE TABLE action_proposals (
  proposal_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  workflow_id uuid NOT NULL,
  step_id text NOT NULL,
  actor text NOT NULL,
  capability_id text NOT NULL,
  target_ref text NOT NULL,
  canonical_request jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_hash text NOT NULL,
  precondition_snapshot_ref text,
  risk_class text NOT NULL,
  reversibility text NOT NULL CHECK (reversibility IN ('reversible','compensatable','irreversible')),
  financial_amount numeric,
  commitment_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
ALTER TABLE action_proposals OWNER TO app_migrator;

CREATE TABLE approval_decisions (
  approval_id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL,
  request_hash text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  owner_principal_id text NOT NULL,
  owner_auth_session_id uuid NOT NULL,
  step_up_mfa_required boolean NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  relevant_state_version text,
  policy_version text NOT NULL,
  decided_at timestamptz NOT NULL,
  expires_at timestamptz,
  consumed_at timestamptz,
  -- Binding integrity: an approval binds to its proposal + request_hash.
  FOREIGN KEY (proposal_id) REFERENCES action_proposals(proposal_id)
);
ALTER TABLE approval_decisions OWNER TO app_migrator;

CREATE TABLE policy_decisions (
  decision_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  proposal_id uuid NOT NULL,
  applicable_grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_version text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('ALLOW','APPROVAL_REQUIRED','DENY')),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  effective_caps jsonb NOT NULL DEFAULT '{}'::jsonb,
  revocation_epoch_checked int NOT NULL,
  kill_epoch_checked int NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE policy_decisions OWNER TO app_migrator;

ALTER TABLE authority_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE authority_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY authority_grants_iso ON authority_grants
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY action_proposals_iso ON action_proposals
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY approval_decisions_iso ON approval_decisions
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY policy_decisions_iso ON policy_decisions
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON authority_grants, action_proposals, approval_decisions, policy_decisions
  TO app_runtime;
