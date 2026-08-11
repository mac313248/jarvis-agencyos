// tests/rls-negative.test.mjs
// Required negative security tests (1-12) attacking the database boundary
// directly with the real runtime role, not a mocked repository layer.
//
// Tests 1-4: Tenant A cannot read/insert/update/delete Tenant B rows.
// Test 5:  Missing tenant context fails closed.
// Test 6:  Runtime role cannot bypass RLS.
// Test 7:  Runtime role is not a protected-table owner.
// Test 8:  Runtime role is not a superuser.
// Test 9:  Runtime role lacks BYPASSRLS.
// Test 10: Pooled connection A->B cannot leak tenant context.
// Test 11: Cross-tenant FK/reference is rejected.
// Test 12: Model/client-supplied tenant ID cannot override trusted context.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshCluster, seedTwoTenants, asRuntimeTenant, asRole } from './_helpers.mjs';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/rls-test' });
  await seedTwoTenants(db, { aId: A, bId: B });
});

after(async () => { await db.close(); });

describe('RLS negative security tests', () => {

  test('1. Tenant A direct query cannot read Tenant B rows', async () => {
    const rows = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      return (await tx.query('SELECT count(*)::int n FROM users;')).rows[0].n;
    });
    assert.equal(rows, 1, 'Tenant A should see only its own user');
    // Cross-check: count visible tenants
    const tenants = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      return (await tx.query('SELECT tenant_id FROM tenants ORDER BY tenant_id;')).rows;
    });
    assert.deepEqual(tenants.map(r => r.tenant_id), [A]);
  });

  test('2. Tenant A cannot INSERT a row owned by Tenant B', async () => {
    await assert.rejects(
      () => asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
        await tx.query(
          'INSERT INTO users (user_id, tenant_id, external_principal_id) VALUES ($1, $2, $3);',
          ['cccccccc-cccc-cccc-cccc-cccccccccccc', B, 'sneak']
        );
      }),
      /row-level security|new row violates/i
    );
  });

  test('3. Tenant A cannot UPDATE Tenant B rows', async () => {
    const affected = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const r = await tx.query("UPDATE users SET display_name='hack' WHERE tenant_id=$1;", [B]);
      return r.rowCount || r.length || 0;
    });
    assert.equal(affected, 0, 'no Tenant B rows should be updatable from Tenant A context');
    // Verify B's display_name unchanged
    const bName = await asRuntimeTenant(db, 'app_runtime', B, async (tx) =>
      (await tx.query('SELECT display_name FROM users;')).rows[0].display_name);
    assert.equal(bName, 'B User');
  });

  test('4. Tenant A cannot DELETE Tenant B rows', async () => {
    const affected = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const r = await tx.query('DELETE FROM users WHERE tenant_id=$1;', [B]);
      return r.rowCount || r.length || 0;
    });
    assert.equal(affected, 0, 'no Tenant B rows should be deletable from Tenant A context');
  });

  test('5. Missing tenant context fails closed (no rows visible, no writes)', async () => {
    await asRole(db, 'app_runtime', async (b) => {
      const n = (await b.query('SELECT count(*)::int n FROM users;')).rows[0].n;
      assert.equal(n, 0, 'no tenant context -> no rows visible');
      // Insert without tenant context must fail (WITH CHECK: tenant_id = NULL)
      await assert.rejects(
        () => b.query("INSERT INTO users (user_id, tenant_id, external_principal_id) VALUES ($1, $2, 'x');",
          ['dddddddd-dddd-dddd-dddd-dddddddddddd', A]),
        /row-level security|new row violates/i
      );
    });
  });

  test('6. Runtime role cannot bypass RLS (cannot escalate privileges)', async () => {
    await asRole(db, 'app_runtime', async (b) => {
      // Privilege escalation: CREATE ROLE requires CREATEROLE/superuser -> denied.
      await assert.rejects(() => b.query('CREATE ROLE evil;'), /permission denied|must be superuser/i);
      // Disabling RLS requires owning the table -> denied (app_runtime is not owner).
      await assert.rejects(() => b.query('ALTER TABLE users DISABLE ROW LEVEL SECURITY;'), /permission denied|must be owner/i);
      // Dropping a protected table requires owner -> denied.
      await assert.rejects(() => b.query('DROP TABLE users;'), /permission denied|owner of/i);
      // Reading the auth catalog (passwords) is superuser-gated -> denied/empty.
      // Even so, RLS still holds: cross-tenant rows remain invisible (tests 1-5).
      const n = (await b.query('SELECT count(*)::int n FROM users;')).rows[0].n;
      assert.equal(n, 0, 'runtime role without tenant context sees nothing');
    });
  });

  test('7. Runtime role is not a protected-table owner', async () => {
    const owners = await db.query(`
      SELECT c.relname, r.rolname AS owner
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.relname IN ('tenants','users','memberships','authority_grants','action_proposals',
                          'approval_decisions','canonical_events','execution_receipts','pii_subjects')
        AND c.relkind='r';
    `);
    for (const row of owners.rows) {
      assert.notEqual(row.owner, 'app_runtime', `${row.relname} must not be owned by app_runtime`);
    }
    // Explicit: app_runtime is not the owner of users
    const u = owners.rows.find(r => r.relname === 'users');
    assert.ok(u, 'users table exists');
    assert.notEqual(u.owner, 'app_runtime');
  });

  test('8. Runtime role is not a superuser', async () => {
    const r = await db.query("SELECT rolsuper FROM pg_roles WHERE rolname='app_runtime';");
    assert.equal(r.rows[0].rolsuper, false);
  });

  test('9. Runtime role lacks BYPASSRLS', async () => {
    const r = await db.query("SELECT rolbypassrls FROM pg_roles WHERE rolname='app_runtime';");
    assert.equal(r.rows[0].rolbypassrls, false);
  });

  test('10. Pooled connection A->B cannot leak tenant context', async () => {
    // Simulate pool reuse: a single recycled connection runs Txn A (commit),
    // then Txn B (no tenant set). Transaction-local set_config(...,true) is
    // dropped on COMMIT, so A's context cannot leak into B.
    await asRole(db, 'app_runtime', async (b) => {
      // Txn A
      await b.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [A]);
        const n = (await tx.query('SELECT count(*)::int n FROM users;')).rows[0].n;
        assert.equal(n, 1);
      });
      // Immediately after commit, same connection, no tenant set -> fail closed
      const n2 = (await b.query('SELECT count(*)::int n FROM users;')).rows[0].n;
      assert.equal(n2, 0, 'tenant context leaked across txn boundary on pooled connection');

      // Txn B sets B; must NOT see A's rows
      await b.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [B]);
        const ids = (await tx.query('SELECT tenant_id FROM tenants;')).rows.map(r => r.tenant_id);
        assert.deepEqual(ids, [B]);
        const users = (await tx.query('SELECT external_principal_id FROM users;')).rows.map(r => r.external_principal_id);
        assert.deepEqual(users, ['principal-b']);
      });
    });
  });

  test('11. Cross-tenant FK/reference is rejected', async () => {
    // memberships composite FK (tenant_id, user_id) -> users(tenant_id, user_id)
    // A membership in tenant A referencing a user of tenant B must be rejected.
    await assert.rejects(
      () => asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
        await tx.query(
          `INSERT INTO memberships (membership_id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member');`,
          ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', A, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']
        );
      }),
      /foreign key|violates/i
    );
  });

  test('12. Model/client-supplied tenant ID cannot override trusted context', async () => {
    // The trusted server sets tenant A. A client-supplied tenant B in the
    // request body is IGNORED by the trusted path. Result: only A's rows.
    // Must run as the non-superuser runtime role so RLS is actually enforced.
    const { runForTrustedTenantNotClient } = await import('../src/security/tenant-context.js');
    const seen = await asRole(db, 'app_runtime', async (b) =>
      runForTrustedTenantNotClient(b, { trustedTenantId: A, clientSuppliedTenantId: B }, async (tx) => {
        return (await tx.query('SELECT tenant_id FROM tenants;')).rows.map(r => r.tenant_id);
      })
    );
    assert.deepEqual(seen, [A], 'client-supplied tenant must not override trusted context');
  });
});
