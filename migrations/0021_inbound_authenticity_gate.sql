-- 0021_inbound_authenticity_gate.sql
-- Explicit inbound authenticity gate contract metadata.
-- Gate enforcement is application-level (src/runtime/inbound-authenticity-gate.js)
-- with DB CHECK from 0009 as defense-in-depth.

INSERT INTO contract_metadata (contract_name, contract_version, git_sha, schema_path)
VALUES (
  'InboundAuthenticityGate',
  1,
  NULL,
  'docs/master-sot/06_SYSTEM_CONTRACTS.md#CanonicalEvent+07_AUTHORITY_SECURITY_EXECUTION.md#Inbound-authenticity'
);
