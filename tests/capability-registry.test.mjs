// tests/capability-registry.test.mjs
// Phase 2 — Governed Capability Registry acceptance tests P2-1..P2-18
// plus Master retests #14 (non-circumvention), #21 (capability_id identity),
// and ambiguity classification structural proof for #25.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshCluster, seedTwoTenants, asRuntimeTenant, asRole } from './_helpers.mjs';
import {
  validateCapabilityContract,
  classifyAmbiguousOutcomePolicy,
  insertCapability,
  syncFallbackRefs,
  CONTROL_SURFACES,
  REVERSIBILITIES,
  PROVIDER_IDEMPOTENCY,
  CAPABILITY_STATUSES,
  FORBIDDEN_SECRET_FIELDS,
  CapabilityValidationError,
} from '../src/contracts/capability.js';
import {
  resolveCapability,
  resolveExecutableCapability,
  CapabilityResolutionError,
} from '../src/contracts/capability-resolver.js';
import { idempotencyKey, requestHash } from '../src/contracts/ids.js';
import {
  BUSINESS_WRITE_AUTONOMY,
  assertBusinessWriteAutonomyDisabled,
  PHASE2_FORBIDDEN_EXECUTION_SURFACES,
} from '../src/runtime/autonomy.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function baseCap(overrides = {}) {
  return {
    contract_version: 1,
    capability_id: 'cap.test.write',
    tenant_scope: 'tenant-owned',
    provider: 'fixture',
    control_surface: 'api',
    adapter: 'fixture.adapter',
    operation: 'noop',
    risk_class: 'low',
    reversibility: 'reversible',
    auth_scope: { scopes: ['read'] },
    credential_ref: 'credref://vault/fixture-1',
    provider_idempotency: 'supported',
    postcondition_observable: true,
    preconditions: {},
    postcondition_verifier: 'fixture.verify',
    fallback_routes: [],
    approval_policy: 'default',
    network_scope: { allow: [] },
    timeout_retry_policy: { timeout_ms: 1000, max_retries: 0 },
    receipt_schema: 'ExecutionReceipt/v1',
    status: 'active',
    ...overrides,
  };
}

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/capability-test' });
  await seedTwoTenants(db, { aId: A, bId: B });
  // Seed distinguishable authority + a revoked grant for non-circumvention tests.
  await db.query(
    `INSERT INTO authority_control (tenant_id, active_authority, revocation_epoch, kill_epoch)
     VALUES ($1, true, 3, 1), ($2, true, 9, 4);`,
    [A, B]
  );
  await db.query(
    `INSERT INTO authority_grants (
       grant_id, tenant_id, principal, capability_action_scope, resource_scope,
       effective_at, issued_by, policy_version, revocation_epoch, status
     ) VALUES (
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', $1, 'principal-a', '{}'::jsonb, '{}'::jsonb,
       now(), 'owner', 'v1', 3, 'revoked'
     );`,
    [A]
  );
});

after(async () => { await db.close(); });

describe('P2-1 capability contract fields', () => {
  test('P2-1 validated object matches canonical 06 field set', () => {
    const cap = validateCapabilityContract(baseCap());
    const keys = Object.keys(cap).sort();
    assert.deepEqual(keys, [
      'adapter', 'approval_policy', 'auth_scope', 'capability_id',
      'contract_version', 'control_surface', 'credential_ref',
      'fallback_routes', 'network_scope', 'operation',
      'postcondition_observable', 'postcondition_verifier', 'preconditions',
      'provider', 'provider_idempotency', 'receipt_schema', 'reversibility',
      'risk_class', 'status', 'tenant_scope', 'timeout_retry_policy',
    ].sort());
  });

  test('P2-1 persisted row round-trips all canonical fields', async () => {
    const input = baseCap({ capability_id: 'cap.roundtrip' });
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await insertCapability(tx, input);
      const row = (await tx.query(
        'SELECT * FROM capabilities WHERE capability_id=$1;',
        ['cap.roundtrip']
      )).rows[0];
      assert.equal(row.contract_version, 1);
      assert.equal(row.capability_id, 'cap.roundtrip');
      assert.equal(row.tenant_scope, 'tenant-owned');
      assert.equal(row.provider, 'fixture');
      assert.equal(row.control_surface, 'api');
      assert.equal(row.adapter, 'fixture.adapter');
      assert.equal(row.operation, 'noop');
      assert.equal(row.risk_class, 'low');
      assert.equal(row.reversibility, 'reversible');
      assert.equal(row.credential_ref, 'credref://vault/fixture-1');
      assert.equal(row.provider_idempotency, 'supported');
      assert.equal(row.postcondition_observable, true);
      assert.equal(row.postcondition_verifier, 'fixture.verify');
      assert.equal(row.approval_policy, 'default');
      assert.equal(row.receipt_schema, 'ExecutionReceipt/v1');
      assert.equal(row.status, 'active');
      assert.equal(row.tenant_id, A);
    });
  });

  test('P2-1 contract_metadata records Capability v1', async () => {
    const r = await db.query(
      `SELECT contract_name, contract_version, schema_path
       FROM contract_metadata WHERE contract_name='Capability';`
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].contract_version, 1);
    assert.match(r.rows[0].schema_path, /06_SYSTEM_CONTRACTS/);
  });
});

describe('P2-2..P2-6 capability RLS / tenant isolation', () => {
  test('seed Tenant B capability as bootstrap, invisible to A', async () => {
    await db.query(
      `INSERT INTO capabilities (
         tenant_id, capability_id, contract_version, tenant_scope, provider,
         control_surface, adapter, operation, risk_class, reversibility,
         auth_scope, credential_ref, provider_idempotency, postcondition_observable,
         preconditions, postcondition_verifier, fallback_routes, approval_policy,
         network_scope, timeout_retry_policy, receipt_schema, status
       ) VALUES (
         $1, 'cap.b.only', 1, 'tenant-owned', 'fixture',
         'api', 'b.adapter', 'op', 'low', 'reversible',
         '{}'::jsonb, 'credref://vault/b', 'supported', true,
         '{}'::jsonb, null, '[]'::jsonb, 'default',
         '{}'::jsonb, '{}'::jsonb, 'ExecutionReceipt/v1', 'active'
       );`,
      [B]
    );
  });

  test('P2-2 Tenant A cannot enumerate/read Tenant B capability rows', async () => {
    const ids = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query('SELECT capability_id FROM capabilities ORDER BY capability_id;'))
        .rows.map(r => r.capability_id)
    );
    assert.ok(!ids.includes('cap.b.only'));
    assert.ok(ids.includes('cap.roundtrip'));
  });

  test('P2-3 Tenant A cannot INSERT/UPDATE/DELETE Tenant B capability rows', async () => {
    await assert.rejects(
      () => asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
        await tx.query(
          `INSERT INTO capabilities (
             tenant_id, capability_id, contract_version, tenant_scope, provider,
             control_surface, adapter, operation, risk_class, reversibility,
             auth_scope, provider_idempotency, postcondition_observable,
             preconditions, fallback_routes, approval_policy,
             network_scope, timeout_retry_policy, receipt_schema, status
           ) VALUES (
             $1, 'cap.sneak', 1, 'x', 'p', 'api', 'a', 'o', 'low', 'reversible',
             '{}'::jsonb, 'supported', true, '{}'::jsonb, '[]'::jsonb, 'default',
             '{}'::jsonb, '{}'::jsonb, 'r', 'active'
           );`,
          [B]
        );
      }),
      /row-level security|new row violates/i
    );

    const updated = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const r = await tx.query(
        `UPDATE capabilities SET status='disabled' WHERE capability_id='cap.b.only';`
      );
      return r.rowCount || 0;
    });
    assert.equal(updated, 0);

    const deleted = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const r = await tx.query(`DELETE FROM capabilities WHERE capability_id='cap.b.only';`);
      return r.rowCount || 0;
    });
    assert.equal(deleted, 0);

    // B still sees its row
    const bStatus = await asRuntimeTenant(db, 'app_runtime', B, async (tx) =>
      (await tx.query(`SELECT status FROM capabilities WHERE capability_id='cap.b.only';`))
        .rows[0].status
    );
    assert.equal(bStatus, 'active');
  });

  test('P2-4 missing tenant context fails closed for capabilities', async () => {
    await asRole(db, 'app_runtime', async (b) => {
      const n = (await b.query('SELECT count(*)::int n FROM capabilities;')).rows[0].n;
      assert.equal(n, 0);
      await assert.rejects(
        () => b.query(
          `INSERT INTO capabilities (
             tenant_id, capability_id, contract_version, tenant_scope, provider,
             control_surface, adapter, operation, risk_class, reversibility,
             auth_scope, provider_idempotency, postcondition_observable,
             preconditions, fallback_routes, approval_policy,
             network_scope, timeout_retry_policy, receipt_schema, status
           ) VALUES (
             $1, 'cap.nocontext', 1, 'x', 'p', 'api', 'a', 'o', 'low', 'reversible',
             '{}'::jsonb, 'supported', true, '{}'::jsonb, '[]'::jsonb, 'default',
             '{}'::jsonb, '{}'::jsonb, 'r', 'active'
           );`,
          [A]
        ),
        /row-level security|new row violates|missing tenant/i
      );
    });
  });

  test('P2-5 runtime role non-superuser / no BYPASSRLS / not capabilities owner', async () => {
    const role = (await db.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='app_runtime';`
    )).rows[0];
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);

    const owners = (await db.query(`
      SELECT c.relname, r.rolname AS owner, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.relname IN ('capabilities','capability_fallback_refs') AND c.relkind='r';
    `)).rows;
    assert.equal(owners.length, 2);
    for (const o of owners) {
      assert.notEqual(o.owner, 'app_runtime');
      assert.equal(o.relrowsecurity, true);
      assert.equal(o.relforcerowsecurity, true);
    }
  });

  test('P2-6 cross-tenant capability fallback reference rejected', async () => {
    // Seed a same-tenant fallback target for A, then try to point A's capability
    // at B's capability via normalized refs (must fail composite FK).
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await insertCapability(tx, baseCap({ capability_id: 'cap.a.fallback.target' }));
      await insertCapability(tx, baseCap({
        capability_id: 'cap.a.with.fallback',
        fallback_routes: ['cap.a.fallback.target'],
      }));
      await syncFallbackRefs(tx, 'cap.a.with.fallback', ['cap.a.fallback.target']);
    });

    await assert.rejects(
      () => asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
        // Attempt: claim fallback to B's capability while keeping tenant_id=A
        // (composite FK requires (A, cap.b.only) to exist — it does not).
        await tx.query(
          `INSERT INTO capability_fallback_refs
             (tenant_id, capability_id, fallback_capability_id)
           VALUES ($1, 'cap.a.with.fallback', 'cap.b.only');`,
          [A]
        );
      }),
      /foreign key|violates/i
    );
  });
});

describe('P2-7..P2-9 / P2-16 resolver lifecycle + tenant binding', () => {
  test('P2-7 unknown capability fails closed', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await assert.rejects(
        () => resolveCapability(tx, 'cap.does.not.exist'),
        (e) => e instanceof CapabilityResolutionError && e.code === 'UNKNOWN_CAPABILITY'
      );
    });
  });

  test('P2-8 status=disabled cannot resolve as executable', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await insertCapability(tx, baseCap({ capability_id: 'cap.disabled', status: 'disabled' }));
      const res = await resolveCapability(tx, 'cap.disabled');
      assert.equal(res.executable, false);
      assert.equal(res.treated_as_active, false);
      assert.equal(res.lifecycle_status, 'disabled');
      await assert.rejects(
        () => resolveExecutableCapability(tx, 'cap.disabled'),
        (e) => e instanceof CapabilityResolutionError && e.code === 'CAPABILITY_NOT_EXECUTABLE'
      );
    });
  });

  test('P2-9 status=degraded is not silently treated as active', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await insertCapability(tx, baseCap({ capability_id: 'cap.degraded', status: 'degraded' }));
      const res = await resolveCapability(tx, 'cap.degraded');
      assert.equal(res.lifecycle_status, 'degraded');
      assert.equal(res.treated_as_active, false);
      assert.equal(res.executable, true); // may execute under degraded policy, but not as ACTIVE
    });
  });

  test('P2-16 resolution bound to trusted tenant; caller cannot select another tenant', async () => {
    // resolveCapability has no tenant_id parameter. Under A context, B's
    // capability is invisible -> UNKNOWN (fail closed), not cross-tenant read.
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await assert.rejects(
        () => resolveCapability(tx, 'cap.b.only'),
        (e) => e instanceof CapabilityResolutionError && e.code === 'UNKNOWN_CAPABILITY'
      );
      // arity / signature check: function length is 2 (backend, capabilityId)
      assert.equal(resolveCapability.length, 2);
    });

    await asRole(db, 'app_runtime', async (b) => {
      await assert.rejects(
        () => resolveCapability(b, 'cap.roundtrip'),
        (e) => e instanceof CapabilityResolutionError && e.code === 'MISSING_TENANT_CONTEXT'
      );
    });
  });
});

describe('P2-10..P2-15 enums, secrets, ambiguity classification', () => {
  test('P2-10 credential_ref opaque; raw secret fields rejected; no secret columns', async () => {
    assert.throws(
      () => validateCapabilityContract(baseCap({ password: 'secret' })),
      CapabilityValidationError
    );
    assert.throws(
      () => validateCapabilityContract(baseCap({ credential_ref: 'sk-live-abcdef' })),
      /opaque reference/i
    );
    const cols = (await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='capabilities' ORDER BY column_name;
    `)).rows.map(r => r.column_name);
    for (const bad of FORBIDDEN_SECRET_FIELDS) {
      assert.ok(!cols.includes(bad), `capabilities must not have column ${bad}`);
    }
    assert.ok(cols.includes('credential_ref'));
  });

  test('P2-11 unsafe idempotency/postcondition never autonomously retryable after ambiguity', () => {
    for (const idem of ['unsupported', 'unknown']) {
      const policy = classifyAmbiguousOutcomePolicy(baseCap({
        provider_idempotency: idem,
        postcondition_observable: false,
      }));
      assert.equal(policy.autonomously_retryable_after_ambiguity, false);
      assert.equal(policy.min_verdict, 'APPROVAL_REQUIRED');
      assert.equal(policy.ambiguous_completion, 'human_or_blocked');
      assert.ok(policy.reason_codes.includes('AUTONOMOUS_RETRY_FORBIDDEN_AFTER_AMBIGUITY'));
    }
    // Safe case may be autonomously retryable when supported + observable
    const safe = classifyAmbiguousOutcomePolicy(baseCap({
      provider_idempotency: 'supported',
      postcondition_observable: true,
    }));
    assert.equal(safe.autonomously_retryable_after_ambiguity, true);
  });

  test('P2-11 resolver surfaces the same classification', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await insertCapability(tx, baseCap({
        capability_id: 'cap.unsafe.ambiguity',
        provider_idempotency: 'unsupported',
        postcondition_observable: false,
      }));
      const res = await resolveCapability(tx, 'cap.unsafe.ambiguity');
      assert.equal(res.ambiguity_policy.autonomously_retryable_after_ambiguity, false);
      assert.equal(res.ambiguity_policy.min_verdict, 'APPROVAL_REQUIRED');
    });
  });

  test('P2-12 control_surface enum enforced', () => {
    for (const v of CONTROL_SURFACES) {
      assert.equal(validateCapabilityContract(baseCap({ control_surface: v })).control_surface, v);
    }
    assert.throws(() => validateCapabilityContract(baseCap({ control_surface: 'ssh' })), CapabilityValidationError);
  });

  test('P2-13 reversibility enum enforced', () => {
    for (const v of REVERSIBILITIES) {
      assert.equal(validateCapabilityContract(baseCap({ reversibility: v })).reversibility, v);
    }
    assert.throws(() => validateCapabilityContract(baseCap({ reversibility: 'undoable' })), CapabilityValidationError);
  });

  test('P2-14 provider_idempotency enum enforced', () => {
    for (const v of PROVIDER_IDEMPOTENCY) {
      assert.equal(validateCapabilityContract(baseCap({ provider_idempotency: v })).provider_idempotency, v);
    }
    assert.throws(() => validateCapabilityContract(baseCap({ provider_idempotency: 'maybe' })), CapabilityValidationError);
  });

  test('P2-15 status enum enforced (DB + validation)', async () => {
    for (const v of CAPABILITY_STATUSES) {
      assert.equal(validateCapabilityContract(baseCap({ status: v })).status, v);
    }
    assert.throws(() => validateCapabilityContract(baseCap({ status: 'archived' })), CapabilityValidationError);
    await assert.rejects(
      () => asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
        await tx.query(
          `INSERT INTO capabilities (
             tenant_id, capability_id, contract_version, tenant_scope, provider,
             control_surface, adapter, operation, risk_class, reversibility,
             auth_scope, provider_idempotency, postcondition_observable,
             preconditions, fallback_routes, approval_policy,
             network_scope, timeout_retry_policy, receipt_schema, status
           ) VALUES (
             $1, 'cap.badstatus', 1, 'x', 'p', 'api', 'a', 'o', 'low', 'reversible',
             '{}'::jsonb, 'supported', true, '{}'::jsonb, '[]'::jsonb, 'default',
             '{}'::jsonb, '{}'::jsonb, 'r', 'archived'
           );`,
          [A]
        );
      }),
      /check constraint|violates/i
    );
  });
});

describe('Master #14 / #21 capability non-circumvention + identity', () => {
  test('#14 resolution cannot revive or circumvent revoked grant / authority', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const beforeGrant = (await tx.query(
        `SELECT status, revocation_epoch FROM authority_grants WHERE status='revoked';`
      )).rows[0];
      assert.equal(beforeGrant.status, 'revoked');
      const beforeAuth = (await tx.query(
        `SELECT active_authority, revocation_epoch, kill_epoch FROM authority_control;`
      )).rows[0];

      const res = await resolveCapability(tx, 'cap.roundtrip');
      assert.equal(res.authority_circumvention, false);
      assert.equal(res.grant_revived, false);
      // Resolution must not invent an ALLOW / grant-active claim
      assert.equal(res.grant_status, undefined);
      assert.equal(res.authority_verdict, undefined);

      const afterGrant = (await tx.query(
        `SELECT status, revocation_epoch FROM authority_grants WHERE status='revoked';`
      )).rows[0];
      assert.deepEqual(afterGrant, beforeGrant);
      const afterAuth = (await tx.query(
        `SELECT active_authority, revocation_epoch, kill_epoch FROM authority_control;`
      )).rows[0];
      assert.deepEqual(afterAuth, beforeAuth);
    });
  });

  test('#21 capability_id identity stable in idempotency key (no alias mutation)', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const res = await resolveCapability(tx, 'cap.roundtrip');
      assert.equal(res.capability.capability_id, 'cap.roundtrip');
      const rh = requestHash({ op: 'noop' });
      const k1 = idempotencyKey({
        tenant_id: A,
        workflow_id: 'wf-1',
        step_id: 's1',
        capability_id: res.capability.capability_id,
        request_hash: rh,
      });
      const k2 = idempotencyKey({
        tenant_id: A,
        workflow_id: 'wf-1',
        step_id: 's1',
        capability_id: 'cap.roundtrip',
        request_hash: rh,
      });
      assert.equal(k1, k2);
    });
  });
});

describe('P2-17 / P2-18 regression posture + autonomy', () => {
  test('P2-18 business-write autonomy DISABLED; no forbidden execution surfaces introduced', () => {
    assert.equal(BUSINESS_WRITE_AUTONOMY, false);
    assert.equal(assertBusinessWriteAutonomyDisabled(), true);
    assert.ok(PHASE2_FORBIDDEN_EXECUTION_SURFACES.includes('business_write_autonomy'));
    assert.ok(PHASE2_FORBIDDEN_EXECUTION_SURFACES.includes('trusted_executor_material_commit'));
    assert.ok(PHASE2_FORBIDDEN_EXECUTION_SURFACES.includes('connector_registry_persistence'));

    // Source scan: Phase 2 modules must not call external fetch/network APIs.
    const phase2Files = [
      'src/contracts/capability.js',
      'src/contracts/capability-resolver.js',
      'src/runtime/autonomy.js',
      'migrations/0011_capability_registry.sql',
    ];
    const root = new URL('..', import.meta.url).pathname;
    for (const rel of phase2Files) {
      const text = readFileSync(join(root, rel), 'utf8');
      assert.doesNotMatch(text, /\bfetch\s*\(/);
      assert.doesNotMatch(text, /\baxios\b/);
      assert.doesNotMatch(text, /\bhttps?:\/\//); // no live endpoint URLs in Phase 2 code
      assert.doesNotMatch(text, /api[_-]?key\s*[:=]/i);
      assert.doesNotMatch(text, /BEGIN PRIVATE KEY/);
    }
  });

  test('P2-17 migration 0011 applied; Phase 1 tables still present', async () => {
    const mig = (await db.query(
      `SELECT id FROM schema_migrations WHERE id='0011_capability_registry';`
    )).rows;
    assert.equal(mig.length, 1);
    const tables = (await db.query(`
      SELECT relname FROM pg_class
      WHERE relkind='r' AND relnamespace='public'::regnamespace
        AND relname IN ('tenants','users','authority_control','capabilities','capability_fallback_refs')
      ORDER BY relname;
    `)).rows.map(r => r.relname);
    assert.deepEqual(tables, [
      'authority_control',
      'capabilities',
      'capability_fallback_refs',
      'tenants',
      'users',
    ]);
  });
});
