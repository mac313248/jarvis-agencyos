-- 0002_tenants_users_memberships.sql
-- Canonical tenants, users/principals, memberships.
-- Confidentiality class per 06_SYSTEM_CONTRACTS.md: FIRST_PARTY_PORTFOLIO | THIRD_PARTY_ISOLATED.

CREATE TABLE tenants (
  tenant_id uuid PRIMARY KEY,
  name text NOT NULL,
  confidentiality_class text NOT NULL
    CHECK (confidentiality_class IN ('FIRST_PARTY_PORTFOLIO','THIRD_PARTY_ISOLATED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants OWNER TO app_migrator;

CREATE TABLE users (
  user_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id),
  external_principal_id text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
ALTER TABLE users OWNER TO app_migrator;

CREATE TABLE memberships (
  membership_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  -- Composite FK enforces tenant-matching: a membership in tenant A cannot
  -- reference a user belonging to tenant B. This is the cross-tenant
  -- relational integrity guard.
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, user_id)
);
ALTER TABLE memberships OWNER TO app_migrator;

-- RLS on all tenant-owned tables.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_iso ON tenants
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY users_iso ON users
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());
CREATE POLICY memberships_iso ON memberships
  USING (tenant_id = cur_tenant()) WITH CHECK (tenant_id = cur_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, memberships TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
