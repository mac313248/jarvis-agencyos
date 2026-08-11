// src/contracts/capability-resolver.js
// Deterministic, tenant-context-bound Capability resolution.
//
// RUNTIME PATH: tenant is derived EXCLUSIVELY from trusted transaction-local
// context (cur_tenant() / RLS). There is NO resolver argument that accepts a
// tenant UUID. Missing tenant context fails closed. Unknown capability fails
// closed. Disabled capabilities never resolve as executable. Degraded is never
// silently treated as active.
//
// This module does NOT execute providers, retry effects, or grant authority.
// Capability resolution returns registry metadata + safety classification only
// and cannot revive or circumvent authority_grants / authority_control state.

import {
  classifyAmbiguousOutcomePolicy,
  validateCapabilityContract,
} from './capability.js';

export class CapabilityResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CapabilityResolutionError';
    this.code = code;
  }
}

function rowToCapability(row) {
  return validateCapabilityContract({
    contract_version: row.contract_version,
    capability_id: row.capability_id,
    tenant_scope: row.tenant_scope,
    provider: row.provider,
    control_surface: row.control_surface,
    adapter: row.adapter,
    operation: row.operation,
    risk_class: row.risk_class,
    reversibility: row.reversibility,
    auth_scope: typeof row.auth_scope === 'string' ? JSON.parse(row.auth_scope) : row.auth_scope,
    credential_ref: row.credential_ref,
    provider_idempotency: row.provider_idempotency,
    postcondition_observable: row.postcondition_observable,
    preconditions: typeof row.preconditions === 'string' ? JSON.parse(row.preconditions) : row.preconditions,
    postcondition_verifier: row.postcondition_verifier,
    fallback_routes: typeof row.fallback_routes === 'string' ? JSON.parse(row.fallback_routes) : row.fallback_routes,
    approval_policy: row.approval_policy,
    network_scope: typeof row.network_scope === 'string' ? JSON.parse(row.network_scope) : row.network_scope,
    timeout_retry_policy: typeof row.timeout_retry_policy === 'string'
      ? JSON.parse(row.timeout_retry_policy)
      : row.timeout_retry_policy,
    receipt_schema: row.receipt_schema,
    status: row.status,
  });
}

// Lookup under current RLS tenant scope. Does not accept tenant_id.
async function loadCapabilityRow(backend, capabilityId) {
  if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
    throw new CapabilityResolutionError('INVALID_CAPABILITY_ID', 'capability_id required');
  }
  const tenant = await backend.query('SELECT cur_tenant() AS t;');
  if (!tenant.rows[0]?.t) {
    throw new CapabilityResolutionError(
      'MISSING_TENANT_CONTEXT',
      'missing tenant context: capability resolution refused (fail-closed)'
    );
  }
  const r = await backend.query(
    `SELECT capability_id, contract_version, tenant_scope, provider, control_surface,
            adapter, operation, risk_class, reversibility, auth_scope, credential_ref,
            provider_idempotency, postcondition_observable, preconditions,
            postcondition_verifier, fallback_routes, approval_policy, network_scope,
            timeout_retry_policy, receipt_schema, status
     FROM capabilities
     WHERE capability_id = $1;`,
    [capabilityId]
  );
  return r.rows[0] ?? null;
}

/**
 * Resolve a capability for the trusted tenant context.
 *
 * @param {object} backend - DB backend already inside a tenant-scoped txn
 * @param {string} capabilityId - canonical capability_id (never aliased/mutated)
 * @returns resolution object with executable flag, lifecycle, and ambiguity policy
 */
export async function resolveCapability(backend, capabilityId) {
  const row = await loadCapabilityRow(backend, capabilityId);
  if (!row) {
    throw new CapabilityResolutionError(
      'UNKNOWN_CAPABILITY',
      `unknown capability: ${capabilityId} (fail-closed)`
    );
  }

  const capability = rowToCapability(row);
  // Preserve canonical capability_id identity exactly as stored — no aliasing.
  if (capability.capability_id !== capabilityId) {
    throw new CapabilityResolutionError(
      'CAPABILITY_ID_MUTATION',
      'capability_id must not mutate during resolution'
    );
  }

  const ambiguity = classifyAmbiguousOutcomePolicy(capability);
  const status = capability.status;
  const treatedAsActive = status === 'active';
  const executable = status === 'active' || status === 'degraded';

  if (status === 'disabled') {
    return {
      found: true,
      executable: false,
      treated_as_active: false,
      lifecycle_status: 'disabled',
      capability,
      ambiguity_policy: ambiguity,
      // Resolution never invents authority / grant verdicts.
      authority_circumvention: false,
      grant_revived: false,
    };
  }

  if (status === 'degraded') {
    return {
      found: true,
      executable: true,
      treated_as_active: false, // explicit: DEGRADED ≠ ACTIVE
      lifecycle_status: 'degraded',
      capability,
      ambiguity_policy: ambiguity,
      authority_circumvention: false,
      grant_revived: false,
    };
  }

  // active
  return {
    found: true,
    executable: true,
    treated_as_active: treatedAsActive,
    lifecycle_status: 'active',
    capability,
    ambiguity_policy: ambiguity,
    authority_circumvention: false,
    grant_revived: false,
  };
}

// Convenience: assert executable resolution or throw.
export async function resolveExecutableCapability(backend, capabilityId) {
  const res = await resolveCapability(backend, capabilityId);
  if (!res.executable) {
    throw new CapabilityResolutionError(
      'CAPABILITY_NOT_EXECUTABLE',
      `capability ${capabilityId} status=${res.lifecycle_status} is not executable`
    );
  }
  return res;
}
