// Child-process worker for real multi-process PostgreSQL boundary tests.
// Invoked via: node tests/support/postgres-boundary-worker.mjs <mode> <json>

import pg from 'pg';

const [mode, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson || '{}');
const { databaseUrl, tenantId, otherTenantId, role = 'app_runtime' } = payload;

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
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
    process.stdout.write(JSON.stringify(r.rows.map((row) => row.tenant_id)));
  } else if (mode === 'missing_context_fails_closed') {
    const r = await client.query('SELECT count(*)::int AS n FROM users;');
    process.stdout.write(String(r.rows[0].n));
  } else if (mode === 'cross_tenant_insert_blocked') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    try {
      await client.query(
        'INSERT INTO users (user_id, tenant_id, external_principal_id) VALUES ($1, $2, $3);',
        ['cccccccc-cccc-cccc-cccc-cccccccccccc', otherTenantId, 'sneak']
      );
      await client.query('COMMIT');
      process.stdout.write('leaked');
    } catch {
      await client.query('ROLLBACK');
      process.stdout.write('blocked');
    }
  } else if (mode === 'pool_leak_fails_closed') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    await client.query('SELECT count(*)::int AS n FROM users;');
    await client.query('COMMIT');
    const r = await client.query('SELECT count(*)::int AS n FROM users;');
    process.stdout.write(String(r.rows[0].n));
  } else if (mode === 'cross_tenant_fk_blocked') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    try {
      await client.query(
        `INSERT INTO memberships (membership_id, tenant_id, user_id, role)
         VALUES ($1, $2, $3, 'member');`,
        ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', tenantId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']
      );
      await client.query('COMMIT');
      process.stdout.write('leaked');
    } catch {
      await client.query('ROLLBACK');
      process.stdout.write('blocked');
    }
  } else if (mode === 'authority_no_context_fails_closed') {
    try {
      const r = await client.query('SELECT * FROM read_authority_state();');
      process.stdout.write(JSON.stringify({ rows: r.rows.length }));
    } catch (err) {
      process.stdout.write(JSON.stringify({ error: err.message.split('\n')[0] }));
    }
  } else if (mode === 'authority_tenant_bound') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    const r = await client.query('SELECT * FROM read_authority_state();');
    await client.query('COMMIT');
    process.stdout.write(JSON.stringify(r.rows[0] || null));
  } else if (mode === 'runtime_role_properties') {
    const r = await client.query(`
      SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
      FROM pg_roles WHERE rolname = 'app_runtime';
    `);
    process.stdout.write(JSON.stringify(r.rows[0] || null));
  } else if (mode === 'disable_rls_blocked') {
    try {
      await client.query('ALTER TABLE users DISABLE ROW LEVEL SECURITY;');
      process.stdout.write('leaked');
    } catch (err) {
      process.stdout.write(JSON.stringify({ blocked: err.message.split('\n')[0] }));
    }
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  await client.end();
}
