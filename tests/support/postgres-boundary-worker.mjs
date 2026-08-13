// Child-process worker for real multi-process PostgreSQL boundary tests.
// Invoked via: node tests/support/postgres-boundary-worker.mjs <mode> <json>

import pg from 'pg';
import { runForTrustedTenantNotClient } from '../../src/security/tenant-context.js';

const [mode, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson || '{}');
const {
  databaseUrl,
  tenantId,
  otherTenantId,
  role = 'app_runtime',
  tables = [],
} = payload;

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function makeTxApi(c) {
  return {
    query: (t, p) => c.query(t, p || []),
    exec: (t, p) => c.query(t, p || []),
    tx: async (fn) => {
      await c.query('BEGIN');
      try {
        const res = await fn(makeTxApi(c));
        await c.query('COMMIT');
        return res;
      } catch (err) {
        try { await c.query('ROLLBACK'); } catch {}
        throw err;
      }
    },
  };
}

try {
  if (role) await client.query(`SET ROLE ${role};`);

  if (mode === 'tenant_user_count') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    const r = await client.query('SELECT count(*)::int AS n FROM users;');
    await client.query('COMMIT');
    process.stdout.write(String(r.rows[0].n));
  } else if (mode === 'cross_tenant_read_blocked') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    const r = await client.query('SELECT tenant_id FROM tenants ORDER BY tenant_id;');
    await client.query('COMMIT');
    writeJson(r.rows.map((row) => row.tenant_id));
  } else if (mode === 'missing_context_fails_closed') {
    const r = await client.query('SELECT count(*)::int AS n FROM users;');
    process.stdout.write(String(r.rows[0].n));
  } else if (mode === 'missing_context_insert_blocked') {
    try {
      await client.query(
        "INSERT INTO users (user_id, tenant_id, external_principal_id) VALUES ($1, $2, 'x');",
        ['dddddddd-dddd-dddd-dddd-dddddddddddd', tenantId]
      );
      writeJson({ passed: false, reason: 'insert without tenant context succeeded' });
    } catch (err) {
      writeJson({ passed: true, error: String(err.message || err) });
    }
  } else if (mode === 'rls_insert_cross_tenant') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    try {
      await client.query(
        'INSERT INTO users (user_id, tenant_id, external_principal_id) VALUES ($1, $2, $3);',
        ['cccccccc-cccc-cccc-cccc-cccccccccccc', otherTenantId, 'sneak']
      );
      await client.query('ROLLBACK');
      writeJson({ passed: false, reason: 'cross-tenant insert succeeded' });
    } catch (err) {
      await client.query('ROLLBACK');
      writeJson({ passed: true, error: String(err.message || err) });
    }
  } else if (mode === 'rls_update_cross_tenant') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    const r = await client.query("UPDATE users SET display_name='hack' WHERE tenant_id=$1;", [otherTenantId]);
    await client.query('COMMIT');
    writeJson({ passed: (r.rowCount || 0) === 0, rowCount: r.rowCount || 0 });
  } else if (mode === 'rls_delete_cross_tenant') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    const r = await client.query('DELETE FROM users WHERE tenant_id=$1;', [otherTenantId]);
    await client.query('COMMIT');
    writeJson({ passed: (r.rowCount || 0) === 0, rowCount: r.rowCount || 0 });
  } else if (mode === 'pool_leak_test') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    const aCount = (await client.query('SELECT count(*)::int AS n FROM users;')).rows[0].n;
    await client.query('COMMIT');
    const leaked = (await client.query('SELECT count(*)::int AS n FROM users;')).rows[0].n;
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [otherTenantId]);
    const tenantIds = (await client.query('SELECT tenant_id FROM tenants;')).rows.map((row) => row.tenant_id);
    const users = (await client.query('SELECT external_principal_id FROM users;')).rows.map((row) => row.external_principal_id);
    await client.query('COMMIT');
    writeJson({
      passed: aCount === 1 && leaked === 0 && tenantIds.length === 1 && tenantIds[0] === otherTenantId && users.length === 1,
      aCount,
      leaked,
      tenantIds,
      users,
    });
  } else if (mode === 'cross_tenant_fk_rejected') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    try {
      await client.query(
        `INSERT INTO memberships (membership_id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member');`,
        ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', tenantId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']
      );
      await client.query('ROLLBACK');
      writeJson({ passed: false, reason: 'cross-tenant FK insert succeeded' });
    } catch (err) {
      await client.query('ROLLBACK');
      writeJson({ passed: true, error: String(err.message || err) });
    }
  } else if (mode === 'client_tenant_override_blocked') {
    const backend = makeTxApi(client);
    const seen = await runForTrustedTenantNotClient(
      backend,
      { trustedTenantId: tenantId, clientSuppliedTenantId: otherTenantId },
      async (tx) => (await tx.query('SELECT tenant_id FROM tenants;')).rows.map((row) => row.tenant_id)
    );
    writeJson({ passed: seen.length === 1 && seen[0] === tenantId, seen });
  } else if (mode === 'authority_outage_fails_closed') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    const r = await client.query('SELECT * FROM read_authority_state();');
    await client.query('COMMIT');
    writeJson({
      passed: !r.rows[0] || r.rows[0].active_authority == null,
      row: r.rows[0] || null,
    });
  } else if (mode === 'role_introspection') {
    const roles = (await client.query(`
      SELECT rolname, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname IN ('app_runtime','app_migrator','postgres')
      ORDER BY rolname;
    `)).rows;
    const relnames = tables.length
      ? tables
      : ['tenants', 'users', 'memberships', 'authority_grants', 'authority_control'];
    const tableRows = (await client.query(`
      SELECT c.relname, r.rolname AS owner, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.relkind = 'r'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname;
    `, [relnames])).rows;
    writeJson({ roles, tables: tableRows });
  } else if (mode === 'runtime_cannot_bypass_rls') {
    const results = {};
    try {
      await client.query('CREATE ROLE evil;');
      results.createRole = 'allowed';
    } catch (err) {
      results.createRole = String(err.message || err);
    }
    try {
      await client.query('ALTER TABLE users DISABLE ROW LEVEL SECURITY;');
      results.disableRls = 'allowed';
    } catch (err) {
      results.disableRls = String(err.message || err);
    }
    const n = (await client.query('SELECT count(*)::int AS n FROM users;')).rows[0].n;
    writeJson({
      passed: results.createRole !== 'allowed'
        && results.disableRls !== 'allowed'
        && n === 0,
      results,
      userCountWithoutTenant: n,
    });
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  await client.end();
}
