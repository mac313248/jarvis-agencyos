// src/runtime/autonomy.js
// Business-write autonomy remains DISABLED until write-path acceptance gates
// pass (docs/master-sot/12_ACCEPTANCE_AND_IMPLEMENTATION.md).
//
// F-08 introduces a trusted executor against a local_fake effect boundary only.
// F-09 introduces DBOS durable workflows (src/runtime/dbos.js) — still with
// live external side effects and business-write autonomy DISABLED.
// F-11 introduces connector registry + opaque credential broker + read-only
// adapters. Writer connectors remain DISABLED (stop condition).
// F-12 introduces observability (receipts/trace, attention, materiality).
// F-13 introduces backup/restore rehearsal (restore must be actually tested).
// F-14 introduces security/privacy acceptance (deletion / PII erasure / tombstone).
// PHASE2_FORBIDDEN_EXECUTION_SURFACES is preserved for Phase 2 regression:
// trusted_executor_material_commit still means live material provider commits.
// 'dbos' / 'connector_registry_persistence' remain on that Phase-2 inventory
// (forbidden then); later phases authorize those surfaces without enabling
// business writes or writer connectors.

export const BUSINESS_WRITE_AUTONOMY = false;

/** F-08/F-09: live external provider commits remain forbidden. */
export const LIVE_EXTERNAL_SIDE_EFFECTS = false;

/** F-09: Postgres-backed durable workflows are in scope; autonomy is not. */
export const DBOS_DURABLE_WORKFLOWS = true;

/** F-11: connector registry persistence is in scope. */
export const CONNECTOR_REGISTRY = true;

/** F-11: opaque credential broker refs are in scope; raw secrets are not. */
export const CREDENTIAL_BROKER_OPAQUE_REFS = true;

/** F-11 stop condition: writer connectors must remain DISABLED. */
export const WRITER_CONNECTORS_ENABLED = false;

/** F-12: observability (materiality, attention, receipt/trace linkage) is in scope. */
export const OBSERVABILITY = true;

/** F-13: backup/restore rehearsal is in scope; unrehearsed restore is a stop. */
export const BACKUP_RESTORE_REHEARSAL = true;

/** F-14: security/privacy acceptance (deletion / PII erasure) is in scope. */
export const SECURITY_PRIVACY_ACCEPTANCE = true;

export function assertBusinessWriteAutonomyDisabled() {
  if (BUSINESS_WRITE_AUTONOMY !== false) {
    throw new Error('BUSINESS_WRITE_AUTONOMY must remain DISABLED');
  }
  if (LIVE_EXTERNAL_SIDE_EFFECTS !== false) {
    throw new Error('LIVE_EXTERNAL_SIDE_EFFECTS must remain DISABLED');
  }
  return true;
}

export function assertWriterConnectorsDisabled() {
  if (WRITER_CONNECTORS_ENABLED !== false) {
    throw new Error('WRITER_CONNECTORS_ENABLED must remain DISABLED (F-11 stop)');
  }
  return true;
}

// Explicit inventory of execution surfaces Phase 2 must NOT introduce.
export const PHASE2_FORBIDDEN_EXECUTION_SURFACES = Object.freeze([
  'live_provider_connection',
  'connector_registry_persistence',
  'credential_broker',
  'trusted_executor_material_commit',
  'dbos',
  'agent_0',
  'external_api_call',
  'external_mcp_call',
  'browser_orgo_fallback',
  'business_write_autonomy',
]);
