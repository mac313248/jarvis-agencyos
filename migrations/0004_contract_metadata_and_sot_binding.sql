-- 0004_contract_metadata_and_sot_binding.sql
-- Contract/version metadata + SOTBuildBinding per 06_SYSTEM_CONTRACTS.md.

CREATE TABLE contract_metadata (
  contract_name text NOT NULL,
  contract_version int NOT NULL,
  git_sha text,
  schema_path text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_name, contract_version)
);
ALTER TABLE contract_metadata OWNER TO app_migrator;

CREATE TABLE sot_build_bindings (
  binding_id uuid PRIMARY KEY,
  sot_manifest_sha256 text NOT NULL,
  git_commit_sha text,
  builder_runtime text NOT NULL,
  reviewer_runtime text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sot_build_bindings OWNER TO app_migrator;

-- Not tenant-owned; not granted to app_runtime.
REVOKE ALL ON contract_metadata, sot_build_bindings FROM PUBLIC;
REVOKE ALL ON contract_metadata, sot_build_bindings FROM app_runtime;
