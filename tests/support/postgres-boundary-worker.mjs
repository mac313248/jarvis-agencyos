// Child-process worker for real multi-process PostgreSQL boundary tests.
// Invoked via: node tests/support/postgres-boundary-worker.mjs <mode> <json>

import pg from 'pg';

const [mode, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson || '{}');
const { databaseUrl, tenantId, role = 'app_runtime' } = payload;

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
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  await client.end();
}
