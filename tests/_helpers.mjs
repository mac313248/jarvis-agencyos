// tests/_helpers.mjs
// Shared test harness: spins up a FRESH PGlite cluster per test file,
// applies all migrations, and exposes helpers for RLS/role/security tests.
//
// PGlite is real PostgreSQL (compiled to WASM). RLS, FORCE RLS, pg_roles
// (rolsuper/rolbypassrls), and transaction-local set_config are the real
// PostgreSQL implementation. The runtime role is exercised via SET ROLE
// (the standard PostgreSQL RLS-testing technique): current_user becomes the
// non-superuser role so RLS/BYPASSRLS/permission checks apply to it.
//
// To run the SAME tests against a real multi-process PostgreSQL cluster
// (separate login connections, real pool), set DATABASE_URL=postgres://...

import { createDb, asRole } from '../src/db/index.js';
import { applyMigrations } from '../src/db/migrator.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.TEST_PGDATA || new URL('../.pgdata/test', import.meta.url).pathname;
// Unique clusters use OS tempdir so read-only Codex review (no write to
// repo-local .pgdata) can still run phase suites like npm run test:f13.
const uniquePgdataRoot = join(tmpdir(), 'jarvis-agencyos-pgdata');

export async function freshCluster({ dataDir: dir, unique = false } = {}) {
  let target = dir || dataDir;
  let ownedUniqueDir = null;
  // Optional unique per-process/test-run dir avoids PGlite WASM RuntimeError
  // when a fixed path is contaminated by a concurrent/review process.
  // Prefer OS tempdir for unique clusters; preserve fixed-path behavior when
  // callers intentionally pass dataDir (e.g. './.pgdata/...').
  if (unique) {
    const prefix = typeof unique === 'string' ? unique : 'cluster';
    await mkdir(uniquePgdataRoot, { recursive: true });
    ownedUniqueDir = await mkdtemp(join(uniquePgdataRoot, `${prefix}-${process.pid}-`));
    target = ownedUniqueDir;
  }
  // Guarantee a TRULY fresh cluster on every call (including re-runs): remove
  // any persisted PGlite data from a previous run so fixed-UUID seeding does
  // not hit duplicate-key errors. Each test file uses its own data dir and
  // closes its db in `after`, so the dir is never locked when we remove it.
  if (!ownedUniqueDir) {
    try { await rm(target, { recursive: true, force: true }); } catch {}
  }
  const db = await createDb({ dataDir: target });
  await applyMigrations(db, new URL('../migrations/', import.meta.url).pathname);
  if (ownedUniqueDir) {
    const close = db.close.bind(db);
    db.close = async () => {
      try { await close(); } finally {
        try { await rm(ownedUniqueDir, { recursive: true, force: true }); } catch {}
      }
    };
  }
  return db;
}

export { asRole };

// Insert two adversarial tenants + a user each, as the bootstrap (superuser)
// path, so RLS tests have real cross-tenant rows to attack.
export async function seedTwoTenants(db, {
  aId = '11111111-1111-1111-1111-111111111111',
  bId = '22222222-2222-2222-2222-222222222222',
} = {}) {
  await db.query(
    `INSERT INTO tenants (tenant_id, name, confidentiality_class) VALUES
       ($1,'Tenant A','FIRST_PARTY_PORTFOLIO'),
       ($2,'Tenant B','THIRD_PARTY_ISOLATED');`,
    [aId, bId]
  );
  await db.query(
    `INSERT INTO users (user_id, tenant_id, external_principal_id, display_name) VALUES
       ($1, $3, 'principal-a', 'A User'),
       ($2, $4, 'principal-b', 'B User');`,
    ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', aId, bId]
  );
  return { aId, bId };
}

// Run a callback as the non-superuser runtime role inside a tenant-scoped txn.
export async function asRuntimeTenant(db, roleName, tenantId, fn) {
  return asRole(db, roleName, async (b) => {
    return b.tx(async (tx) => {
      await tx.query('SELECT set_tenant($1);', [tenantId]);
      return fn(tx);
    });
  });
}
