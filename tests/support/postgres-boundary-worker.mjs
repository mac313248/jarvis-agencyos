// Child-process worker for real multi-process PostgreSQL boundary tests.
// Invoked via: node tests/support/postgres-boundary-worker.mjs <mode> <json>

import pg from 'pg';

const [mode, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson || '{}');
const { databaseUrl, tenantId, role = 'app_runtime' } = payload;

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

const PROTECTED_TABLES = [
  'tenants',
  'users',
  'memberships',
  'authority_grants',
  'action_proposals',
  'approval_decisions',
  'canonical_events',
  'execution_receipts',
  'pii_subjects',
];

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function writeText(value) {
  process.stdout.write(String(value));
}

async function withRuntime(client) {
  if (role) await client.query(`SET ROLE ${role};`);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await withRuntime(client);

  if (mode === 'tenant_user_count') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    const r = await client.query('SELECT count(*)::int AS n FROM users;');
    await client.query('COMMIT');
    writeText(r.rows[0].n);
  } else if (mode === 'cross_tenant_read_blocked') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId]);
    const r = await client.query('SELECT tenant_id FROM tenants ORDER BY tenant_id;');
    await client.query('COMMIT');
    writeJson(r.rows.map((row) => row.tenant_id));
  } else if (mode === 'missing_context_fails_closed') {
    const r = await client.query('SELECT count(*)::int AS n FROM users;');
    writeText(r.rows[0].n);
  } else if (mode === 'role_posture') {
    const roleRow = (
      await client.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='app_runtime';"
      )
    ).rows[0];
    const owners = (
      await client.query(`
        SELECT c.relname, r.rolname AS owner
        FROM pg_class c
        JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.relkind = 'r'
          AND c.relnamespace = 'public'::regnamespace
          AND c.relname = ANY($1::text[])
        ORDER BY c.relname;
      `, [PROTECTED_TABLES])
    ).rows;
    writeJson({
      rolsuper: roleRow?.rolsuper ?? null,
      rolbypassrls: roleRow?.rolbypassrls ?? null,
      table_owners: owners,
      runtime_owns_protected_table: owners.some((row) => row.owner === 'app_runtime'),
    });
  } else if (mode === 'force_rls_flags') {
    const rows = (
      await client.query(`
        SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY($1::text[])
        ORDER BY c.relname;
      `, [PROTECTED_TABLES])
    ).rows;
    writeJson(rows);
  } else if (mode === 'pool_leak_after_commit') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [tenantId || A]);
    const inTxn = (await client.query('SELECT count(*)::int AS n FROM users;')).rows[0].n;
    await client.query('COMMIT');
    const postCommit = (await client.query('SELECT count(*)::int AS n FROM users;')).rows[0].n;
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', [B]);
    const tenantB = (await client.query('SELECT tenant_id FROM tenants ORDER BY tenant_id;')).rows.map(
      (row) => row.tenant_id
    );
    await client.query('COMMIT');
    writeJson({ in_txn_count: inTxn, post_commit_count: postCommit, tenant_b_visible: tenantB });
  } else if (mode === 'cross_tenant_insert_blocked') {
    let blocked = false;
    let error = null;
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_tenant($1);', [A]);
      await client.query(
        'INSERT INTO users (user_id, tenant_id, external_principal_id) VALUES ($1, $2, $3);',
        ['cccccccc-cccc-cccc-cccc-cccccccccccc', B, 'sneak']
      );
      await client.query('COMMIT');
    } catch (err) {
      blocked = true;
      error = String(err.message || err).split('\n')[0];
      try { await client.query('ROLLBACK'); } catch {}
    }
    writeJson({ blocked, error });
  } else if (mode === 'cross_tenant_fk_blocked') {
    let blocked = false;
    let error = null;
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_tenant($1);', [A]);
      await client.query(
        `INSERT INTO memberships (membership_id, tenant_id, user_id, role)
         VALUES ($1, $2, $3, 'member');`,
        ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', A, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']
      );
      await client.query('COMMIT');
    } catch (err) {
      blocked = true;
      error = String(err.message || err).split('\n')[0];
      try { await client.query('ROLLBACK'); } catch {}
    }
    writeJson({ blocked, error });
  } else if (mode === 'privilege_escalation_blocked') {
    const results = {};
    for (const [name, sql] of [
      ['create_role', 'CREATE ROLE evil_boundary_test;'],
      ['disable_rls', 'ALTER TABLE users DISABLE ROW LEVEL SECURITY;'],
      ['drop_table', 'DROP TABLE users;'],
    ]) {
      try {
        await client.query(sql);
        results[name] = { blocked: false };
      } catch (err) {
        results[name] = {
          blocked: true,
          error: String(err.message || err).split('\n')[0],
        };
      }
    }
    writeJson(results);
  } else if (mode === 'invalid_tenant_fails_closed') {
    await client.query('BEGIN');
    await client.query('SELECT set_tenant($1);', ['00000000-0000-0000-0000-000000000000']);
    const users = (await client.query('SELECT count(*)::int AS n FROM users;')).rows[0].n;
    const tenants = (await client.query('SELECT count(*)::int AS n FROM tenants;')).rows[0].n;
    await client.query('COMMIT');
    writeJson({ users, tenants });
  } else if (mode === 'authority_no_context_fails_closed') {
    const r = await client.query('SELECT count(*)::int AS n FROM authority_control;');
    writeJson({ count: r.rows[0].n });
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  await client.end();
}
