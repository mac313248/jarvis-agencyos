// src/contracts/grants.js
// Authority grant load/match for the trusted executor.
// Fail-closed: missing, revoked, expired, or out-of-scope grants deny execution.
// Tenant scope comes exclusively from trusted transaction-local context.

export class GrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GrantError';
    this.code = code;
  }
}

function scopeAllowsCapability(scope, capabilityId) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
  if (scope.allow_all === true) return true;
  const ids = scope.capability_ids ?? scope.capabilities;
  if (Array.isArray(ids)) return ids.includes(capabilityId);
  return false;
}

/**
 * Load the first active, in-scope grant for principal + capability under
 * current tenant context. Returns null when none qualify (caller DENYs).
 */
export async function loadActiveGrant(backend, { principal, capability_id, now = Date.now() }) {
  if (typeof principal !== 'string' || principal.length === 0) {
    throw new GrantError('INVALID_PRINCIPAL', 'principal required');
  }
  if (typeof capability_id !== 'string' || capability_id.length === 0) {
    throw new GrantError('INVALID_CAPABILITY_ID', 'capability_id required');
  }

  const tenant = await backend.query('SELECT cur_tenant() AS t;');
  if (!tenant.rows[0]?.t) {
    throw new GrantError('MISSING_TENANT_CONTEXT', 'missing tenant context: grant load refused');
  }

  const r = await backend.query(
    `SELECT grant_id, tenant_id, principal, capability_action_scope, resource_scope,
            risk_ceiling, spend_cap, commitment_cap, approval_mode,
            effective_at, expires_at, issued_by, policy_version,
            revocation_epoch, status
     FROM authority_grants
     WHERE principal = $1
       AND status = 'active'
     ORDER BY effective_at DESC;`,
    [principal]
  );

  for (const row of r.rows) {
    const scope = typeof row.capability_action_scope === 'string'
      ? JSON.parse(row.capability_action_scope)
      : row.capability_action_scope;
    if (!scopeAllowsCapability(scope, capability_id)) continue;
    const effectiveAt = new Date(row.effective_at).getTime();
    if (Number.isFinite(effectiveAt) && effectiveAt > now) continue;
    if (row.expires_at) {
      const exp = new Date(row.expires_at).getTime();
      if (Number.isFinite(exp) && exp <= now) continue;
    }
    return {
      grant_id: row.grant_id,
      tenant_id: row.tenant_id,
      principal: row.principal,
      capability_action_scope: scope,
      resource_scope: typeof row.resource_scope === 'string'
        ? JSON.parse(row.resource_scope)
        : row.resource_scope,
      risk_ceiling: row.risk_ceiling,
      spend_cap: row.spend_cap,
      commitment_cap: row.commitment_cap,
      approval_mode: row.approval_mode,
      effective_at: row.effective_at,
      expires_at: row.expires_at,
      issued_by: row.issued_by,
      policy_version: row.policy_version,
      revocation_epoch: row.revocation_epoch,
      status: row.status,
    };
  }
  return null;
}

/** Explicit deny helper for revoked/expired rows (negative tests). */
export async function loadGrantById(backend, grantId) {
  const r = await backend.query(
    `SELECT grant_id, tenant_id, principal, capability_action_scope, resource_scope,
            risk_ceiling, spend_cap, commitment_cap, approval_mode,
            effective_at, expires_at, issued_by, policy_version,
            revocation_epoch, status
     FROM authority_grants WHERE grant_id = $1;`,
    [grantId]
  );
  return r.rows[0] ?? null;
}
