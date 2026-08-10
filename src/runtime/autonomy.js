// src/runtime/autonomy.js
// Business-write autonomy remains DISABLED until write-path acceptance gates
// pass (docs/master-sot/12_ACCEPTANCE_AND_IMPLEMENTATION.md).
//
// F-08 introduces a trusted executor against a local_fake effect boundary only.
// F-09 introduces DBOS durable workflows (src/runtime/dbos.js) — still with
// live external side effects and business-write autonomy DISABLED.
// PHASE2_FORBIDDEN_EXECUTION_SURFACES is preserved for Phase 2 regression:
// trusted_executor_material_commit still means live material provider commits.
// 'dbos' remains on that Phase-2 inventory (forbidden then); F-09 authorizes
// the durable-workflow surface without enabling business writes.

export const BUSINESS_WRITE_AUTONOMY = false;

/** F-08/F-09: live external provider commits remain forbidden. */
export const LIVE_EXTERNAL_SIDE_EFFECTS = false;

/** F-09: Postgres-backed durable workflows are in scope; autonomy is not. */
export const DBOS_DURABLE_WORKFLOWS = true;

export function assertBusinessWriteAutonomyDisabled() {
  if (BUSINESS_WRITE_AUTONOMY !== false) {
    throw new Error('BUSINESS_WRITE_AUTONOMY must remain DISABLED');
  }
  if (LIVE_EXTERNAL_SIDE_EFFECTS !== false) {
    throw new Error('LIVE_EXTERNAL_SIDE_EFFECTS must remain DISABLED');
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
