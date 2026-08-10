// src/contracts/authority.js
// Authority / kill control primitives per 07_AUTHORITY_SECURITY_EXECUTION.md.
//
// Fail-closed: if fresh authority/kill state cannot be obtained, material
// writes are DENIED. Epochs are re-read immediately before commit and
// recorded in the ExecutionReceipt. No live business-effect path is created
// here; the control logic is exercised against a fake/non-business boundary.
//
// RUNTIME PATH (app_runtime): the tenant is derived EXCLUSIVELY from the
// trusted transaction-local tenant context (cur_tenant()). app_runtime CANNOT
// select a tenant by argument — there is no runtime-callable function that
// takes a tenant UUID. Missing tenant context fails closed.
//
// BOOTSTRAP PATH (migrator/superuser only): readFreshAuthorityFor() reads a
// specific tenant directly from authority_control. This is NOT exposed to
// app_runtime; it is used only by bootstrap/internal/test code that already
// owns/escapes RLS.

export class AuthorityUnavailableError extends Error {
  constructor(tenantId) { super(`authority state unavailable for tenant ${tenantId} (fail-closed)`); this.name = 'AuthorityUnavailableError'; }
}

// RUNTIME reader: zero-arg, derives tenant from trusted context.
// Calls the DB function read_authority_state() which filters by cur_tenant().
// Throws (fail-closed) if no tenant context or no authority row.
export async function readFreshAuthority(backend) {
  const r = await backend.query('SELECT * FROM read_authority_state();');
  const row = r.rows?.[0];
  // cur_tenant() is NULL when no trusted tenant context is set -> no row.
  if (!row || row.active_authority === null || row.active_authority === undefined) {
    throw new AuthorityUnavailableError('<runtime: missing tenant context>');
  }
  return {
    activeAuthority: row.active_authority,
    revocationEpoch: row.revocation_epoch,
    killEpoch: row.kill_epoch,
  };
}

// BOOTSTRAP/internal reader: reads a SPECIFIC tenant directly from
// authority_control. NOT exposed to app_runtime (caller must be
// migrator/superuser; RLS does not apply to owners/superusers).
export async function readFreshAuthorityFor(backend, tenantId) {
  const r = await backend.query(
    'SELECT active_authority, revocation_epoch, kill_epoch FROM authority_control WHERE tenant_id = $1;',
    [tenantId]
  );
  const row = r.rows?.[0];
  if (!row || row.active_authority === null || row.active_authority === undefined) {
    throw new AuthorityUnavailableError(tenantId);
  }
  return {
    activeAuthority: row.active_authority,
    revocationEpoch: row.revocation_epoch,
    killEpoch: row.kill_epoch,
  };
}

// Decide whether a material commit is allowed given fresh authority state.
// Returns { allowed: boolean, reasons[] }.
export function commitAllowed({ activeAuthority, revocationEpoch, killEpoch, expectedRevocationEpoch, expectedKillEpoch }) {
  const reasons = [];
  if (!activeAuthority) reasons.push('authority not active');
  if (revocationEpoch !== expectedRevocationEpoch) reasons.push('revocation_epoch changed before commit');
  if (killEpoch !== expectedKillEpoch) reasons.push('kill_epoch changed before commit');
  return { allowed: reasons.length === 0, reasons };
}

// RUNTIME TOCTOU guard: revalidate mutable epochs immediately before a
// (future) material commit. Tenant comes from trusted context.
export async function revalidateBeforeCommit(backend, priorRevocationEpoch, priorKillEpoch) {
  const fresh = await readFreshAuthority(backend);
  const decision = commitAllowed({
    ...fresh,
    expectedRevocationEpoch: priorRevocationEpoch,
    expectedKillEpoch: priorKillEpoch,
  });
  return { decision, fresh };
}

// BOOTSTRAP TOCTOU guard: as above but for a specific tenant (internal/test).
export async function revalidateBeforeCommitFor(backend, tenantId, priorRevocationEpoch, priorKillEpoch) {
  const fresh = await readFreshAuthorityFor(backend, tenantId);
  const decision = commitAllowed({
    ...fresh,
    expectedRevocationEpoch: priorRevocationEpoch,
    expectedKillEpoch: priorKillEpoch,
  });
  return { decision, fresh };
}
