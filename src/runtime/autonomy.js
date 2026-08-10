// src/runtime/autonomy.js
// Business-write autonomy remains DISABLED until write-path acceptance gates
// pass (docs/master-sot/12_ACCEPTANCE_AND_IMPLEMENTATION.md).
//
// Phase 2 introduces NO external execution surface and must not flip this flag.

export const BUSINESS_WRITE_AUTONOMY = false;

export function assertBusinessWriteAutonomyDisabled() {
  if (BUSINESS_WRITE_AUTONOMY !== false) {
    throw new Error('BUSINESS_WRITE_AUTONOMY must remain DISABLED in Phase 2');
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
