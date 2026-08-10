// src/contracts/authority.js
// Authority / kill control primitives per 07_AUTHORITY_SECURITY_EXECUTION.md.
//
// Fail-closed: if fresh authority/kill state cannot be obtained, material
// writes are DENIED. Epochs are re-read immediately before commit and
// recorded in the ExecutionReceipt. No live business-effect path is created
// here; the control logic is exercised against a fake/non-business boundary.

export class AuthorityUnavailableError extends Error {
  constructor(tenantId) { super(`authority state unavailable for tenant ${tenantId} (fail-closed)`); this.name = 'AuthorityUnavailableError'; }
}

// Read fresh authority/kill state for a tenant. Throws (fail-closed) if the
// state cannot be obtained (no row). Returns { activeAuthority, revocationEpoch, killEpoch }.
export async function readFreshAuthority(backend, tenantId) {
  // Expand the composite return type into columns for portable parsing across
  // PGlite (WASM) and libpq (node-pg).
  const r = await backend.query('SELECT * FROM read_authority_state($1);', [tenantId]);
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

// Revalidate mutable epochs immediately before a (future) material commit.
// This is the TOCTOU guard. Returns the epochs to record in the receipt.
export async function revalidateBeforeCommit(backend, tenantId, priorRevocationEpoch, priorKillEpoch) {
  const fresh = await readFreshAuthority(backend, tenantId);
  const decision = commitAllowed({
    ...fresh,
    expectedRevocationEpoch: priorRevocationEpoch,
    expectedKillEpoch: priorKillEpoch,
  });
  return { decision, fresh };
}
