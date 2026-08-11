-- 0003_owner_auth.sql
-- Owner identity / authentication foundation per 06 OwnerAuthContext.
-- Owner is the single human root of trust; NOT tenant-scoped (cross-tenant).
-- High-risk approval requires auth_strength=step_up_mfa with unexpired step-up.

CREATE TABLE owner_principals (
  owner_principal_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE owner_principals OWNER TO app_migrator;

CREATE TABLE mfa_enrollments (
  enrollment_id uuid PRIMARY KEY,
  owner_principal_id text NOT NULL REFERENCES owner_principals(owner_principal_id),
  method text NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('active','disabled'))
);
ALTER TABLE mfa_enrollments OWNER TO app_migrator;

CREATE TABLE owner_sessions (
  session_id uuid PRIMARY KEY,
  owner_principal_id text NOT NULL REFERENCES owner_principals(owner_principal_id),
  auth_strength text NOT NULL CHECK (auth_strength IN ('standard','step_up_mfa')),
  authenticated_at timestamptz NOT NULL,
  step_up_verified_at timestamptz,
  step_up_expires_at timestamptz,
  session_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE owner_sessions OWNER TO app_migrator;

-- Owner tables are NOT tenant-owned (owner is root, cross-tenant). They are
-- managed only through the trusted owner path; runtime tenant role has no
-- access to them, so they are intentionally NOT granted to app_runtime.
REVOKE ALL ON owner_principals, mfa_enrollments, owner_sessions FROM PUBLIC;
REVOKE ALL ON owner_principals, mfa_enrollments, owner_sessions FROM app_runtime;
