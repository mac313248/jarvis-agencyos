// tests/connector-registry.test.mjs
// F-11 Connector registry + read-only connector adapters.
// Acceptance: #44 third-party tenant data never becomes global raw durable memory.
// Stop conditions: raw secret in worker message; writer connector enabled.
// BUSINESS_WRITE_AUTONOMY remains DISABLED.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshCluster, seedTwoTenants, asRuntimeTenant, asRole } from './_helpers.mjs';
import {
  validateConnectorContract,
  insertConnector,
  loadConnector,
  assertReadOnlyConnector,
  ConnectorValidationError,
  CONNECTOR_ACCESS_MODES,
  CONNECTOR_STATUSES,
  FORBIDDEN_SECRET_FIELDS,
} from '../src/contracts/connector.js';
import {
  createCredentialBroker,
  assertNoRawSecretsInWorkerMessage,
  CredentialBrokerError,
} from '../src/runtime/credential-broker.js';
import { createReadOnlyConnectorAdapter } from '../src/runtime/connectors/read-only-adapter.js';
import {
  classifyGlobalMemoryIngest,
  ingestGlobalDurableMemory,
  promoteConnectorReadToGlobalMemory,
  DurableMemoryError,
} from '../src/runtime/durable-memory.js';
import {
  BUSINESS_WRITE_AUTONOMY,
  LIVE_EXTERNAL_SIDE_EFFECTS,
  WRITER_CONNECTORS_ENABLED,
  CONNECTOR_REGISTRY,
  CREDENTIAL_BROKER_OPAQUE_REFS,
  assertBusinessWriteAutonomyDisabled,
  assertWriterConnectorsDisabled,
} from '../src/runtime/autonomy.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function baseConnector(overrides = {}) {
  return {
    contract_version: 1,
    connector_id: 'conn.fixture.read',
    provider: 'fixture',
    control_surface: 'api',
    adapter: 'fixture.read_only',
    access_mode: 'read_only',
    capability_ids: ['cap.fixture.read'],
    credential_broker_ref: 'credbroker://vault/fixture-read-1',
    authenticity_verification_ref: 'authver://hmac/fixture-1',
    auth_scope: { scopes: ['read'] },
    network_scope: { allow: [] },
    status: 'active',
    ...overrides,
  };
}

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/connector-test' });
  await seedTwoTenants(db, { aId: A, bId: B });
});

after(async () => { await db.close(); });

describe('F-11 connector contract + registry', () => {
  test('validated connector matches F-11 field set (Capability-bound)', () => {
    const conn = validateConnectorContract(baseConnector());
    assert.deepEqual(Object.keys(conn).sort(), [
      'access_mode', 'adapter', 'auth_scope', 'authenticity_verification_ref',
      'capability_ids', 'connector_id', 'contract_version', 'control_surface',
      'credential_broker_ref', 'network_scope', 'provider', 'status',
    ].sort());
    assert.equal(conn.access_mode, 'read_only');
  });

  test('contract_metadata records Connector v1 bound to Capability+Credential architecture', async () => {
    const r = await db.query(
      `SELECT contract_name, contract_version, schema_path
       FROM contract_metadata WHERE contract_name='Connector';`
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].contract_version, 1);
    assert.match(r.rows[0].schema_path, /Capability/);
    assert.match(r.rows[0].schema_path, /Credential-architecture/);
  });

  test('persisted connector round-trips under trusted tenant', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await insertConnector(tx, baseConnector({ connector_id: 'conn.roundtrip' }));
      const loaded = await loadConnector(tx, 'conn.roundtrip');
      assert.equal(loaded.connector_id, 'conn.roundtrip');
      assert.equal(loaded.access_mode, 'read_only');
      assert.equal(loaded.credential_broker_ref, 'credbroker://vault/fixture-read-1');
      assert.equal(loaded.authenticity_verification_ref, 'authver://hmac/fixture-1');
    });
  });

  test('writer access_mode rejected by contract + DB CHECK', async () => {
    assert.throws(
      () => validateConnectorContract(baseConnector({ access_mode: 'write' })),
      ConnectorValidationError
    );
    assert.throws(
      () => assertReadOnlyConnector({ access_mode: 'read_write' }),
      /writer connector disabled/i
    );
    await assert.rejects(
      () => asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
        await tx.query(
          `INSERT INTO connectors (
             tenant_id, connector_id, contract_version, provider, control_surface,
             adapter, access_mode, capability_ids, auth_scope, network_scope, status
           ) VALUES (
             $1, 'conn.writer', 1, 'fixture', 'api',
             'w', 'write', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'active'
           );`,
          [A]
        );
      }),
      /check constraint|violates/i
    );
  });

  test('opaque credential_broker_ref; raw secret fields rejected; no secret columns', async () => {
    assert.throws(
      () => validateConnectorContract(baseConnector({ api_key: 'sekrit' })),
      ConnectorValidationError
    );
    assert.throws(
      () => validateConnectorContract(baseConnector({
        credential_broker_ref: 'sk-live-abcdef',
      })),
      /opaque reference/i
    );
    const cols = (await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='connectors' ORDER BY column_name;
    `)).rows.map((r) => r.column_name);
    for (const bad of FORBIDDEN_SECRET_FIELDS) {
      assert.ok(!cols.includes(bad), `connectors must not have column ${bad}`);
    }
    assert.ok(cols.includes('credential_broker_ref'));
    assert.ok(cols.includes('authenticity_verification_ref'));
    assert.deepEqual([...CONNECTOR_ACCESS_MODES], ['read_only']);
    assert.ok(CONNECTOR_STATUSES.includes('active'));
  });

  test('nested secret keys/values in auth_scope/network_scope rejected by validateConnectorContract', () => {
    assert.throws(
      () => validateConnectorContract(baseConnector({
        auth_scope: { nested: { api_key: 'nested-secret' } },
      })),
      /raw credential-bearing field forbidden: auth_scope\.nested\.api_key/i
    );
    assert.throws(
      () => validateConnectorContract(baseConnector({
        network_scope: { headers: { Authorization: 'Bearer leaked-token' } },
      })),
      /raw secret value forbidden at network_scope\.headers\.Authorization/i
    );
    assert.throws(
      () => validateConnectorContract(baseConnector({
        auth_scope: { providers: [{ token: 'x' }] },
      })),
      /auth_scope\.providers\[0\]\.token/i
    );
    // Permitted non-secret nested metadata still validates.
    const ok = validateConnectorContract(baseConnector({
      auth_scope: { scopes: ['read'], audience: 'fixture' },
      network_scope: { allow: ['api.fixture.test'], deny: [] },
    }));
    assert.equal(ok.auth_scope.audience, 'fixture');
  });

  test('direct SQL nested secret metadata in auth_scope/network_scope rejected by DB', async () => {
    await assert.rejects(
      () => asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
        await tx.query(
          `INSERT INTO connectors (
             tenant_id, connector_id, contract_version, provider, control_surface,
             adapter, access_mode, capability_ids, auth_scope, network_scope, status
           ) VALUES (
             $1, 'conn.nested.secret', 1, 'fixture', 'api',
             'a', 'read_only', '[]'::jsonb,
             '{"meta":{"api_key":"nested-db-secret"}}'::jsonb,
             '{}'::jsonb, 'active'
           );`,
          [A]
        );
      }),
      /check constraint|violates|forbidden_secret|connectors_auth_scope_no_secrets/i
    );
    await assert.rejects(
      () => asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
        await tx.query(
          `INSERT INTO connectors (
             tenant_id, connector_id, contract_version, provider, control_surface,
             adapter, access_mode, capability_ids, auth_scope, network_scope, status
           ) VALUES (
             $1, 'conn.nested.sk', 1, 'fixture', 'api',
             'a', 'read_only', '[]'::jsonb,
             '{}'::jsonb,
             '{"upstream":{"value":"sk-live-nested-db"}}'::jsonb,
             'active'
           );`,
          [A]
        );
      }),
      /check constraint|violates|forbidden_secret|connectors_network_scope_no_secrets/i
    );
  });
});

describe('F-11 connector RLS / tenant isolation', () => {
  test('seed Tenant B connector; invisible to A', async () => {
    await db.query(
      `INSERT INTO connectors (
         tenant_id, connector_id, contract_version, provider, control_surface,
         adapter, access_mode, capability_ids, credential_broker_ref,
         authenticity_verification_ref, auth_scope, network_scope, status
       ) VALUES (
         $1, 'conn.b.only', 1, 'fixture', 'api',
         'b.adapter', 'read_only', '[]'::jsonb, 'credbroker://vault/b',
         'authver://b', '{}'::jsonb, '{}'::jsonb, 'active'
       );`,
      [B]
    );
    const ids = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query('SELECT connector_id FROM connectors ORDER BY connector_id;'))
        .rows.map((r) => r.connector_id)
    );
    assert.ok(!ids.includes('conn.b.only'));
    assert.ok(ids.includes('conn.roundtrip'));
  });

  test('Tenant A cannot INSERT/UPDATE/DELETE Tenant B connectors', async () => {
    await assert.rejects(
      () => asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
        await tx.query(
          `INSERT INTO connectors (
             tenant_id, connector_id, contract_version, provider, control_surface,
             adapter, access_mode, capability_ids, auth_scope, network_scope, status
           ) VALUES (
             $1, 'conn.sneak', 1, 'p', 'api', 'a', 'read_only',
             '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'active'
           );`,
          [B]
        );
      }),
      /row-level security|new row violates/i
    );
    const updated = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const r = await tx.query(
        `UPDATE connectors SET status='disabled' WHERE connector_id='conn.b.only';`
      );
      return r.rowCount || 0;
    });
    assert.equal(updated, 0);
  });

  test('missing tenant context fails closed for connectors', async () => {
    await asRole(db, 'app_runtime', async (b) => {
      const n = (await b.query('SELECT count(*)::int n FROM connectors;')).rows[0].n;
      assert.equal(n, 0);
      await assert.rejects(
        () => loadConnector(b, 'conn.roundtrip'),
        /missing tenant context/i
      );
    });
  });

  test('runtime role non-superuser / no BYPASSRLS / not connectors owner', async () => {
    const role = (await db.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='app_runtime';`
    )).rows[0];
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    const owners = (await db.query(`
      SELECT c.relname, r.rolname AS owner, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.relname = 'connectors' AND c.relkind='r';
    `)).rows;
    assert.equal(owners.length, 1);
    assert.notEqual(owners[0].owner, 'app_runtime');
    assert.equal(owners[0].relrowsecurity, true);
    assert.equal(owners[0].relforcerowsecurity, true);
  });
});

describe('F-11 opaque credential broker + worker messages', () => {
  test('worker message carries opaque ref only; raw secret refused', () => {
    const broker = createCredentialBroker();
    const { credential_broker_ref } = broker.register({
      tenant_id: A,
      secret: 'super-secret-token-NEVER-IN-MESSAGE',
      scopes: ['read'],
      access: 'read',
    });
    const msg = broker.buildWorkerMessage({
      tenant_id: A,
      connector_id: 'conn.roundtrip',
      capability_id: 'cap.fixture.read',
      credential_broker_ref,
      operation: 'read',
      payload: { resource_key: 'contact:1' },
    });
    assert.equal(msg.credential_broker_ref, credential_broker_ref);
    assert.equal(msg.secret, undefined);
    assert.equal(msg.token, undefined);
    assert.equal(msg.api_key, undefined);
    assert.doesNotMatch(JSON.stringify(msg), /super-secret-token/);
    assert.equal(assertNoRawSecretsInWorkerMessage(msg), true);

    assert.throws(
      () => assertNoRawSecretsInWorkerMessage({
        tenant_id: A,
        api_key: 'sk-live-leak',
      }),
      (e) => e instanceof CredentialBrokerError && e.code === 'RAW_SECRET_IN_WORKER_MESSAGE'
    );
    assert.throws(
      () => assertNoRawSecretsInWorkerMessage({
        tenant_id: A,
        payload: { token: 'Bearer abc' },
      }),
      /RAW_SECRET_IN_WORKER_MESSAGE|raw secret/i
    );
  });

  test('reader workloads do not inherit writer credentials', () => {
    const broker = createCredentialBroker();
    const { credential_broker_ref } = broker.register({
      tenant_id: A,
      secret: 'writer-secret',
      scopes: ['write'],
      access: 'write',
    });
    assert.throws(
      () => broker.resolveHandle({
        tenant_id: A,
        credential_broker_ref,
        workload: 'reader',
      }),
      (e) => e instanceof CredentialBrokerError &&
        e.code === 'WRITER_CREDENTIAL_DENIED_TO_READER'
    );
  });
});

describe('F-11 read-only adapters', () => {
  test('read-only adapter returns fixture data without secrets', async () => {
    const broker = createCredentialBroker();
    const { credential_broker_ref } = broker.register({
      tenant_id: A,
      secret: 'adapter-secret-hidden',
      scopes: ['read'],
      access: 'read',
    });
    const adapter = createReadOnlyConnectorAdapter({ broker });
    adapter.seedFixture('contact:1', { id: 'contact:1', status: 'active' });

    const connector = baseConnector({
      connector_id: 'conn.adapter',
      credential_broker_ref,
    });
    const worker_message = broker.buildWorkerMessage({
      tenant_id: A,
      connector_id: 'conn.adapter',
      capability_id: 'cap.fixture.read',
      credential_broker_ref,
      operation: 'read',
      payload: { resource_key: 'contact:1' },
    });

    const result = await adapter.execute({
      connector,
      tenant_id: A,
      worker_message,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { id: 'contact:1', status: 'active' });
    assert.equal(result.credential_broker_ref, credential_broker_ref);
    assert.doesNotMatch(JSON.stringify(result), /adapter-secret-hidden/);
  });

  test('write operation and writer connector are stopped', async () => {
    const broker = createCredentialBroker();
    const { credential_broker_ref } = broker.register({
      tenant_id: A,
      secret: 'x',
      scopes: ['read'],
      access: 'read',
    });
    const adapter = createReadOnlyConnectorAdapter({ broker });
    const connector = baseConnector({ credential_broker_ref });

    await assert.rejects(
      () => adapter.execute({
        connector,
        tenant_id: A,
        worker_message: {
          tenant_id: A,
          connector_id: connector.connector_id,
          capability_id: 'cap.fixture.read',
          credential_broker_ref,
          operation: 'update',
          payload: { resource_key: 'contact:1' },
        },
      }),
      /WRITE_OPERATION_FORBIDDEN|write operation forbidden/i
    );

    await assert.rejects(
      () => adapter.execute({
        connector: { ...connector, access_mode: 'write' },
        tenant_id: A,
        worker_message: {
          tenant_id: A,
          connector_id: connector.connector_id,
          capability_id: 'cap.fixture.read',
          credential_broker_ref,
          operation: 'read',
          payload: { resource_key: 'contact:1' },
        },
      }),
      /WRITER_CONNECTOR|writer connector/i
    );
  });
});

describe('Master #44 third-party tenant data never becomes global raw durable memory', () => {
  test('#44 policy classifies third-party raw connector reads as forbidden', () => {
    const denied = classifyGlobalMemoryIngest({
      source_confidentiality_class: 'THIRD_PARTY_ISOLATED',
      memory_class: 'DEIDENTIFIED_AGGREGATE',
      payload: {
        kind: 'raw_connector_read',
        raw_tenant_data: true,
        data: { email: 'client@example.com', phone: '+15551212' },
      },
    });
    assert.equal(denied.allowed, false);
    assert.match(denied.code, /RAW_TENANT|FORBIDDEN/);
  });

  test('#44 promoteConnectorReadToGlobalMemory refuses third-party raw read', async () => {
    await assert.rejects(
      () => promoteConnectorReadToGlobalMemory(db, {
        tenant_confidentiality_class: 'THIRD_PARTY_ISOLATED',
        tenant_id: B,
        connector_read_result: {
          data: { customer_email: 'raw@client.test', full_name: 'Raw Client' },
        },
      }),
      (e) => e instanceof DurableMemoryError
    );

    // Direct ingest of raw third-party payload also refused.
    await assert.rejects(
      () => ingestGlobalDurableMemory(db, {
        source_confidentiality_class: 'THIRD_PARTY_ISOLATED',
        source_tenant_id: B,
        memory_class: 'OPERATIONAL_METADATA',
        payload: { raw_tenant_data: true, notes: 'client transcript' },
      }),
      DurableMemoryError
    );
  });

  test('#44 permitted de-identified third-party aggregate may enter global memory', async () => {
    const result = await ingestGlobalDurableMemory(db, {
      source_confidentiality_class: 'THIRD_PARTY_ISOLATED',
      source_tenant_id: B,
      memory_class: 'DEIDENTIFIED_AGGREGATE',
      payload: {
        permitted: true,
        deidentified: true,
        metric: 'connector_read_count',
        value: 3,
      },
    });
    assert.equal(result.ingested, true);
    const rows = (await db.query(
      `SELECT memory_class, source_confidentiality_class, payload
       FROM global_durable_memory WHERE memory_id = $1;`,
      [result.memory_id]
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_confidentiality_class, 'THIRD_PARTY_ISOLATED');
    assert.equal(rows[0].payload.raw_tenant_data, undefined);
    assert.equal(rows[0].payload.deidentified, true);
  });

  test('#44 SQL CHECK rejects raw_tenant_data=true payload', async () => {
    await assert.rejects(
      () => db.query(
        `INSERT INTO global_durable_memory (
           memory_id, memory_class, source_confidentiality_class, payload
         ) VALUES (
           '33333333-3333-3333-3333-333333333333',
           'OPERATIONAL_METADATA', 'THIRD_PARTY_ISOLATED',
           '{"raw_tenant_data":"true","x":1}'::jsonb
         );`
      ),
      /check constraint|violates/i
    );
  });

  test('#44 direct SQL INSERT as app_runtime cannot bypass policy with raw payload omitting raw_tenant_data', async () => {
    // Privilege gate: app_runtime has no direct INSERT.
    await assert.rejects(
      () => asRole(db, 'app_runtime', async (b) => {
        await b.query(
          `INSERT INTO global_durable_memory (
             memory_id, memory_class, source_confidentiality_class, payload
           ) VALUES (
             '44444444-4444-4444-4444-444444444444',
             'OPERATIONAL_METADATA', 'THIRD_PARTY_ISOLATED',
             '{"customer_email":"bypass@client.test","full_name":"Bypass Client"}'::jsonb
           );`
        );
      }),
      /permission denied|violates|check constraint/i
    );

    // Even via controlled function: PII-shaped third-party payload without
    // raw_tenant_data flag is rejected (fail closed).
    await assert.rejects(
      () => asRole(db, 'app_runtime', async (b) => {
        await b.query(
          `SELECT ingest_global_durable_memory(
             '55555555-5555-5555-5555-555555555555'::uuid,
             'OPERATIONAL_METADATA',
             'THIRD_PARTY_ISOLATED',
             $1::uuid,
             '{"customer_email":"bypass@client.test","full_name":"Bypass Client"}'::jsonb
           );`,
          [B]
        );
      }),
      /RAW_TENANT_DATA_FORBIDDEN|check constraint|violates/i
    );

    // Third-party payload that only omits permitted/deidentified also fails.
    await assert.rejects(
      () => asRole(db, 'app_runtime', async (b) => {
        await b.query(
          `SELECT ingest_global_durable_memory(
             '66666666-6666-6666-6666-666666666666'::uuid,
             'OPERATIONAL_METADATA',
             'THIRD_PARTY_ISOLATED',
             $1::uuid,
             '{"metric":"reads","value":9}'::jsonb
           );`,
          [B]
        );
      }),
      /THIRD_PARTY_NOT_PERMITTED|check constraint|violates/i
    );

    const leaked = (await db.query(
      `SELECT count(*)::int AS n FROM global_durable_memory
       WHERE payload::text ILIKE '%bypass@client.test%';`
    )).rows[0].n;
    assert.equal(leaked, 0);
  });

  test('#44 permitted de-identified third-party aggregate still works through controlled path', async () => {
    const memoryId = await asRole(db, 'app_runtime', async (b) => {
      const r = await b.query(
        `SELECT ingest_global_durable_memory(
           '77777777-7777-7777-7777-777777777777'::uuid,
           'DEIDENTIFIED_AGGREGATE',
           'THIRD_PARTY_ISOLATED',
           $1::uuid,
           '{"permitted":true,"deidentified":true,"metric":"connector_read_count","value":7}'::jsonb
         ) AS memory_id;`,
        [B]
      );
      return r.rows[0].memory_id;
    });
    assert.equal(memoryId, '77777777-7777-7777-7777-777777777777');
    const row = (await db.query(
      `SELECT source_confidentiality_class, payload
       FROM global_durable_memory WHERE memory_id = $1;`,
      [memoryId]
    )).rows[0];
    assert.equal(row.source_confidentiality_class, 'THIRD_PARTY_ISOLATED');
    assert.equal(row.payload.permitted, true);
    assert.equal(row.payload.deidentified, true);
    assert.equal(row.payload.raw_tenant_data, undefined);
  });

  test('#44 end-to-end: third-party read stays out of global raw memory', async () => {
    const broker = createCredentialBroker();
    const { credential_broker_ref } = broker.register({
      tenant_id: B,
      secret: 'third-party-secret',
      scopes: ['read'],
      access: 'read',
    });
    await asRuntimeTenant(db, 'app_runtime', B, async (tx) => {
      await insertConnector(tx, baseConnector({
        connector_id: 'conn.b.read',
        credential_broker_ref,
      }));
    });

    const adapter = createReadOnlyConnectorAdapter({ broker });
    adapter.seedFixture('lead:9', {
      customer_email: 'lead@thirdparty.test',
      full_name: 'Third Party Lead',
    });
    const connector = baseConnector({
      connector_id: 'conn.b.read',
      credential_broker_ref,
    });
    const worker_message = broker.buildWorkerMessage({
      tenant_id: B,
      connector_id: 'conn.b.read',
      capability_id: 'cap.fixture.read',
      credential_broker_ref,
      operation: 'get',
      payload: { resource_key: 'lead:9' },
    });
    const read = await adapter.execute({
      connector,
      tenant_id: B,
      worker_message,
    });
    assert.equal(read.data.customer_email, 'lead@thirdparty.test');

    await assert.rejects(
      () => promoteConnectorReadToGlobalMemory(db, {
        tenant_confidentiality_class: 'THIRD_PARTY_ISOLATED',
        tenant_id: B,
        connector_read_result: read,
      }),
      /raw|forbidden|AGGREGATE_REQUIRED|third-party/i
    );

    // Explicit permitted aggregate is the only third-party global path.
    const ok = await promoteConnectorReadToGlobalMemory(db, {
      tenant_confidentiality_class: 'THIRD_PARTY_ISOLATED',
      tenant_id: B,
      connector_read_result: read,
      memory_class: 'OPERATIONAL_METADATA',
      aggregate_payload: {
        permitted: true,
        metric: 'reads',
        value: 1,
      },
    });
    assert.equal(ok.ingested, true);

    const rawHits = (await db.query(
      `SELECT count(*)::int AS n FROM global_durable_memory
       WHERE payload::text ILIKE '%lead@thirdparty.test%'
          OR payload::text ILIKE '%Third Party Lead%';`
    )).rows[0].n;
    assert.equal(rawHits, 0);
  });
});

describe('F-11 autonomy + stop conditions', () => {
  test('business-write autonomy DISABLED; writer connectors DISABLED', () => {
    assert.equal(BUSINESS_WRITE_AUTONOMY, false);
    assert.equal(LIVE_EXTERNAL_SIDE_EFFECTS, false);
    assert.equal(WRITER_CONNECTORS_ENABLED, false);
    assert.equal(CONNECTOR_REGISTRY, true);
    assert.equal(CREDENTIAL_BROKER_OPAQUE_REFS, true);
    assert.equal(assertBusinessWriteAutonomyDisabled(), true);
    assert.equal(assertWriterConnectorsDisabled(), true);
  });

  test('F-11 sources contain no inline raw provider secrets / writer enablement', () => {
    const root = new URL('..', import.meta.url).pathname;
    const files = [
      'src/contracts/connector.js',
      'src/runtime/credential-broker.js',
      'src/runtime/connectors/read-only-adapter.js',
      'src/runtime/durable-memory.js',
      'src/runtime/autonomy.js',
      'migrations/0015_connector_registry.sql',
      'migrations/0016_f11_memory_secret_gates.sql',
    ];
    for (const rel of files) {
      const text = readFileSync(join(root, rel), 'utf8');
      assert.doesNotMatch(text, /BEGIN PRIVATE KEY/);
      assert.doesNotMatch(text, /sk-live-[A-Za-z0-9]+/);
      assert.doesNotMatch(text, /WRITER_CONNECTORS_ENABLED\s*=\s*true/);
      assert.doesNotMatch(text, /BUSINESS_WRITE_AUTONOMY\s*=\s*true/);
    }
  });

  test('migration 0015 and 0016 applied; app_runtime has no direct INSERT on global memory', async () => {
    const mig = (await db.query(
      `SELECT id FROM schema_migrations
       WHERE id IN ('0015_connector_registry','0016_f11_memory_secret_gates')
       ORDER BY id;`
    )).rows.map((r) => r.id);
    assert.deepEqual(mig, [
      '0015_connector_registry',
      '0016_f11_memory_secret_gates',
    ]);
    const insertPriv = (await db.query(`
      SELECT has_table_privilege('app_runtime', 'global_durable_memory', 'INSERT') AS can_insert,
             has_table_privilege('app_runtime', 'global_durable_memory', 'SELECT') AS can_select;
    `)).rows[0];
    assert.equal(insertPriv.can_insert, false);
    assert.equal(insertPriv.can_select, true);
  });
});
