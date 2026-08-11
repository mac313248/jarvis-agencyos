// src/security/tenant-context.js
// Trusted transaction-local tenant context.
//
// CRITICAL: tenant context is set ONLY from trusted server-resolved identity,
// never from model/request body/client input. The DB enforces that whatever
// tenant is set, only that tenant's rows are visible (RLS). Missing/invalid
// context fails closed (NULL tenant -> no rows, no writes).
//
// Transaction-local: set_config(..., true) is dropped on COMMIT/ROLLBACK, so a
// pooled connection reused for Tenant B after Tenant A cannot leak A's
// context. TenantContext.run wraps each unit of work in its own transaction.

export async function setTenant(backend, tenantId) {
  if (!tenantId) throw new Error('setTenant: tenantId required (fail-closed)');
  await backend.query('SELECT set_tenant($1);', [tenantId]);
}

export async function currentTenant(backend) {
  const r = await backend.query('SELECT cur_tenant() AS t;');
  return r.rows[0]?.t ?? null;
}

// Run `fn` inside a transaction scoped to a trusted tenant. The tenant is
// provided ONLY by trusted server code; client-supplied tenant IDs must be
// ignored by the caller (see tests/rls-negative.test.mjs).
export async function runForTenant(backend, trustedTenantId, fn) {
  if (!trustedTenantId) {
    throw new Error('runForTenant: missing trusted tenant context (fail-closed)');
  }
  return backend.tx(async (tx) => {
    await tx.query('SELECT set_tenant($1);', [trustedTenantId]);
    return fn(tx);
  });
}

// Verify a model/client-supplied tenant cannot override the trusted context.
// The trusted tenant always wins; the client value is never passed to set_tenant.
export async function runForTrustedTenantNotClient(backend, { trustedTenantId, clientSuppliedTenantId }, fn) {
  return runForTenant(backend, trustedTenantId, fn);
}
