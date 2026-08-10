// tests/trusted-executor.test.mjs
// F-08 Trusted executor acceptance:
//   #21 deterministic idempotency key stable across restart
//   #22 duplicate same logical effect executes at most once
//   #23 crash after external commit but before local completion does not duplicate
//   #28 unknown effect remains AMBIGUOUS/UNKNOWN never silently SUCCEEDED
//
// Stop conditions covered: no verified receipt claimed success;
// fail-closed (not fail-open) on authority/kill outage.
// Business-write autonomy remains DISABLED; local_fake adapter only.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import { insertCapability } from '../src/contracts/capability.js';
import { idempotencyKey, requestHash, sha256Hex } from '../src/contracts/ids.js';
import {
  executeTrustedEffect,
  computeEffectIdempotencyKey,
  CrashAfterCommitError,
  TrustedExecutorError,
} from '../src/runtime/trusted-executor.js';
import { createLocalEffectAdapter } from '../src/runtime/local-effect-adapter.js';
import {
  BUSINESS_WRITE_AUTONOMY,
  LIVE_EXTERNAL_SIDE_EFFECTS,
  assertBusinessWriteAutonomyDisabled,
} from '../src/runtime/autonomy.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const PRINCIPAL = 'principal-a';
const CAP_ID = 'cap.local.noop';

function baseCap(overrides = {}) {
  return {
    contract_version: 1,
    capability_id: CAP_ID,
    tenant_scope: 'tenant-owned',
    provider: 'local_fake',
    control_surface: 'api',
    adapter: 'local.fake',
    operation: 'noop_write',
    risk_class: 'low',
    reversibility: 'reversible',
    auth_scope: { scopes: ['write:local'] },
    credential_ref: null,
    provider_idempotency: 'supported',
    postcondition_observable: true,
    preconditions: {},
    postcondition_verifier: 'local_fake.verify',
    fallback_routes: [],
    approval_policy: 'default',
    network_scope: { allow: [] },
    timeout_retry_policy: { timeout_ms: 1000, max_retries: 0 },
    receipt_schema: 'ExecutionReceipt/v1',
    status: 'active',
    ...overrides,
  };
}

async function seedGrant(tx, { grantId = randomUUID(), status = 'active', capabilityId = CAP_ID } = {}) {
  await tx.query(
    `INSERT INTO authority_grants (
       grant_id, tenant_id, principal, capability_action_scope, resource_scope,
       approval_mode, effective_at, issued_by, policy_version, revocation_epoch, status
     ) VALUES (
       $1, cur_tenant(), $2, $3::jsonb, '{}'::jsonb,
       'default', now(), 'owner', 'v1', 0, $4
     );`,
    [grantId, PRINCIPAL, JSON.stringify({ capability_ids: [capabilityId] }), status]
  );
  return grantId;
}

async function seedProposal(tx, overrides = {}) {
  const proposalId = overrides.proposal_id || randomUUID();
  const workflowId = overrides.workflow_id || randomUUID();
  const stepId = overrides.step_id || 'step-1';
  const canonical = overrides.canonical_request || { op: 'noop', n: 1 };
  const rh = overrides.request_hash || requestHash(canonical);
  await tx.query(
    `INSERT INTO action_proposals (
       proposal_id, tenant_id, workflow_id, step_id, actor, capability_id,
       target_ref, canonical_request, request_hash, risk_class, reversibility
     ) VALUES (
       $1, cur_tenant(), $2, $3, 'agent0', $4,
       'local:target', $5::jsonb, $6, 'low', 'reversible'
     );`,
    [proposalId, workflowId, stepId, CAP_ID, JSON.stringify(canonical), rh]
  );
  return { proposal_id: proposalId, workflow_id: workflowId, step_id: stepId, request_hash: rh, canonical_request: canonical };
}

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/trusted-executor-test' });
  await seedTwoTenants(db, { aId: A, bId: B });
  await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
    await tx.query(
      `INSERT INTO authority_control (tenant_id, active_authority, revocation_epoch, kill_epoch)
       VALUES ($1, true, 0, 0);`,
      [A]
    );
    await insertCapability(tx, baseCap());
    await seedGrant(tx);
  });
  await asRuntimeTenant(db, 'app_runtime', B, async (tx) => {
    await tx.query(
      `INSERT INTO authority_control (tenant_id, active_authority, revocation_epoch, kill_epoch)
       VALUES ($1, true, 5, 2);`,
      [B]
    );
  });
});

after(async () => { await db.close(); });

describe('F-08 autonomy posture', () => {
  test('business-write autonomy and live external side effects remain DISABLED', () => {
    assert.equal(BUSINESS_WRITE_AUTONOMY, false);
    assert.equal(LIVE_EXTERNAL_SIDE_EFFECTS, false);
    assert.equal(assertBusinessWriteAutonomyDisabled(), true);
  });

  test('rejects non-local_fake adapters', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const p = await seedProposal(tx, { step_id: 'reject-live' });
      await assert.rejects(
        () => executeTrustedEffect(tx, {
          proposal_id: p.proposal_id,
          principal: PRINCIPAL,
          adapter: { surface: 'live_provider', commit: async () => ({}), verifyPostcondition: async () => ({}) },
        }),
        (e) => e instanceof TrustedExecutorError && e.code === 'LIVE_EXTERNAL_FORBIDDEN'
      );
    });
  });
});

describe('Master #21 deterministic idempotency key', () => {
  test('#21 deterministic idempotency key is stable across restart', async () => {
    const parts = {
      tenant_id: A,
      workflow_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      step_id: 'step-stable',
      capability_id: CAP_ID,
      request_hash: sha256Hex('canonical-stable'),
    };
    const k1 = computeEffectIdempotencyKey(parts);
    const kDirect = idempotencyKey(parts);
    assert.equal(k1, kDirect);

    const mod2 = await import('../src/runtime/trusted-executor.js?r=' + Math.random());
    const k2 = mod2.computeEffectIdempotencyKey(parts);
    assert.equal(k1, k2);

    const manual = sha256Hex([
      parts.tenant_id, parts.workflow_id, parts.step_id, parts.capability_id, parts.request_hash,
    ].join(''));
    assert.equal(k1, manual);
  });
});

describe('Master #22 at-most-once', () => {
  test('#22 duplicate same logical effect executes at most once', async () => {
    const store = new Map();
    const adapter = createLocalEffectAdapter(store);
    let commitCalls = 0;
    const countingAdapter = {
      ...adapter,
      surface: adapter.surface,
      hasCommitted: (k) => adapter.hasCommitted(k),
      getCommitted: (k) => adapter.getCommitted(k),
      verifyPostcondition: (a) => adapter.verifyPostcondition(a),
      async commit(args) {
        commitCalls += 1;
        return adapter.commit(args);
      },
    };

    const logical = {
      workflow_id: randomUUID(),
      step_id: 'step-once',
      canonical_request: { op: 'noop', tag: 'once' },
    };

    const first = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const p = await seedProposal(tx, logical);
      return executeTrustedEffect(tx, {
        proposal_id: p.proposal_id,
        principal: PRINCIPAL,
        adapter: countingAdapter,
      });
    });
    assert.equal(first.status, 'SUCCEEDED');
    assert.equal(first.verification_status, 'VERIFIED');
    assert.equal(first.claimed_success, true);
    assert.equal(commitCalls, 1);
    assert.equal(store.size, 1);

    // F-12: live executor receipts must resolve to a real execution_traces row.
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const { resolveReceiptTrace } = await import('../src/runtime/observability.js');
      const resolved = await resolveReceiptTrace(tx, {
        receipt_id: first.receipt_id,
        tenant_id: A,
      });
      assert.ok(resolved.trace_id);
      assert.ok(resolved.trace);
      assert.equal(resolved.trace.root_span, 'trusted_executor');
      assert.equal(resolved.trace.status, 'open');
    });

    // Same logical effect (same workflow/step/request) on a new proposal row is
    // still the same idempotency key when fields match — seed identical inputs.
    const second = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      // Re-use the same proposal: re-executing the same proposal_id.
      return executeTrustedEffect(tx, {
        proposal_id: (await tx.query(
          `SELECT proposal_id FROM action_proposals
           WHERE workflow_id=$1 AND step_id=$2 LIMIT 1;`,
          [logical.workflow_id, logical.step_id]
        )).rows[0].proposal_id,
        principal: PRINCIPAL,
        adapter: countingAdapter,
      });
    });

    assert.equal(second.duplicate, true);
    assert.equal(second.status, 'SUCCEEDED');
    assert.equal(commitCalls, 1, 'adapter.commit must not run again');
    assert.equal(store.size, 1);

    const receipts = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        `SELECT count(*)::int n FROM execution_receipts WHERE idempotency_key=$1;`,
        [first.idempotency_key]
      )).rows[0].n
    );
    assert.equal(receipts, 1);
  });
});

describe('Master #23 crash after commit', () => {
  test('#23 crash after external commit but before local completion does not duplicate effect', async () => {
    const store = new Map();
    const adapter = createLocalEffectAdapter(store);
    let commitCalls = 0;
    const countingAdapter = {
      surface: adapter.surface,
      hasCommitted: (k) => adapter.hasCommitted(k),
      getCommitted: (k) => adapter.getCommitted(k),
      verifyPostcondition: (a) => adapter.verifyPostcondition(a),
      async commit(args) {
        commitCalls += 1;
        return adapter.commit(args);
      },
    };

    const logical = {
      workflow_id: randomUUID(),
      step_id: 'step-crash',
      canonical_request: { op: 'noop', tag: 'crash' },
    };

    let proposalId;
    await assert.rejects(
      async () => {
        await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
          const p = await seedProposal(tx, logical);
          proposalId = p.proposal_id;
          await executeTrustedEffect(tx, {
            proposal_id: p.proposal_id,
            principal: PRINCIPAL,
            adapter: countingAdapter,
            injectCrash: 'after_commit',
          });
        });
      },
      (e) => e instanceof CrashAfterCommitError
    );

    assert.equal(commitCalls, 1);
    assert.equal(store.size, 1, 'external/local adapter retained the commit across crash');

    // Local ledger/receipt rolled back with the crashed txn; recovery must not re-commit.
    const recovered = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      // Proposal insert also rolled back — re-seed identical logical proposal.
      const p = await seedProposal(tx, { ...logical, proposal_id: proposalId });
      return executeTrustedEffect(tx, {
        proposal_id: p.proposal_id,
        principal: PRINCIPAL,
        adapter: countingAdapter,
      });
    });

    assert.equal(commitCalls, 1, 'must not duplicate adapter commit after crash');
    assert.equal(store.size, 1);
    assert.equal(recovered.status, 'SUCCEEDED');
    assert.equal(recovered.verification_status, 'VERIFIED');
    assert.equal(recovered.claimed_success, true);
    assert.equal(recovered.resumed || recovered.duplicate, true);

    const receipts = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        `SELECT verification_status FROM execution_receipts WHERE idempotency_key=$1;`,
        [recovered.idempotency_key]
      )).rows
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].verification_status, 'VERIFIED');
  });
});

describe('Master #28 unknown never SUCCEEDED', () => {
  test('#28 unknown effect remains AMBIGUOUS/UNKNOWN never silently SUCCEEDED', async () => {
    const store = new Map();
    const adapter = createLocalEffectAdapter(store, { defaultPostcondition: 'UNKNOWN' });

    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const p = await seedProposal(tx, {
        step_id: 'step-unknown',
        canonical_request: { op: 'noop', tag: 'unknown' },
      });
      return executeTrustedEffect(tx, {
        proposal_id: p.proposal_id,
        principal: PRINCIPAL,
        adapter,
        forcedPostcondition: 'UNKNOWN',
      });
    });

    assert.equal(result.status, 'AMBIGUOUS');
    assert.equal(result.verification_status, 'AMBIGUOUS');
    assert.equal(result.claimed_success, false);
    assert.notEqual(result.status, 'SUCCEEDED');

    const row = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        `SELECT outcome, postcondition_status
         FROM effect_ledger WHERE idempotency_key=$1;`,
        [result.idempotency_key]
      )).rows[0]
    );
    assert.equal(row.outcome, 'AMBIGUOUS');
    assert.equal(row.postcondition_status, 'UNKNOWN');

    const receipt = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        `SELECT verification_status FROM execution_receipts WHERE receipt_id=$1;`,
        [result.receipt_id]
      )).rows[0]
    );
    assert.equal(receipt.verification_status, 'AMBIGUOUS');
  });

  test('AMBIGUOUS postcondition cannot claim success', async () => {
    const adapter = createLocalEffectAdapter(new Map());
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const p = await seedProposal(tx, {
        step_id: 'step-ambiguous',
        canonical_request: { op: 'noop', tag: 'ambiguous' },
      });
      return executeTrustedEffect(tx, {
        proposal_id: p.proposal_id,
        principal: PRINCIPAL,
        adapter,
        forcedPostcondition: 'AMBIGUOUS',
      });
    });
    assert.equal(result.status, 'AMBIGUOUS');
    assert.equal(result.claimed_success, false);
  });
});

describe('F-08 fail-closed authority/kill + grant', () => {
  test('authority/kill outage denies (fail-closed, not fail-open)', async () => {
    const C = '33333333-3333-3333-3333-333333333333';
    await db.query(
      `INSERT INTO tenants (tenant_id, name, confidentiality_class)
       VALUES ($1, 'Tenant C', 'THIRD_PARTY_ISOLATED');`,
      [C]
    );
    // No authority_control row for C → readFreshAuthority fails closed.
    await asRuntimeTenant(db, 'app_runtime', C, async (tx) => {
      await insertCapability(tx, baseCap({ capability_id: 'cap.c.noop' }));
      await seedGrant(tx, { capabilityId: 'cap.c.noop' });
      const proposalId = randomUUID();
      const canonical = { op: 'x' };
      await tx.query(
        `INSERT INTO action_proposals (
           proposal_id, tenant_id, workflow_id, step_id, actor, capability_id,
           target_ref, canonical_request, request_hash, risk_class, reversibility
         ) VALUES (
           $1, cur_tenant(), $2, 's', 'agent0', 'cap.c.noop',
           't', $3::jsonb, $4, 'low', 'reversible'
         );`,
        [proposalId, randomUUID(), JSON.stringify(canonical), requestHash(canonical)]
      );
      const result = await executeTrustedEffect(tx, {
        proposal_id: proposalId,
        principal: PRINCIPAL,
        adapter: createLocalEffectAdapter(),
      });
      assert.equal(result.status, 'DENIED');
      assert.equal(result.claimed_success, false);
      assert.ok(result.reason_codes.includes('AUTHORITY_KILL_STORE_UNAVAILABLE'));
    });
  });

  test('revoked grant denies execution', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await insertCapability(tx, baseCap({ capability_id: 'cap.revoked.only' }));
      await seedGrant(tx, { capabilityId: 'cap.revoked.only', status: 'revoked' });
      const proposalId = randomUUID();
      const canonical = { op: 'revoked' };
      await tx.query(
        `INSERT INTO action_proposals (
           proposal_id, tenant_id, workflow_id, step_id, actor, capability_id,
           target_ref, canonical_request, request_hash, risk_class, reversibility
         ) VALUES (
           $1, cur_tenant(), $2, 's', 'agent0', 'cap.revoked.only',
           't', $3::jsonb, $4, 'low', 'reversible'
         );`,
        [proposalId, randomUUID(), JSON.stringify(canonical), requestHash(canonical)]
      );
      const result = await executeTrustedEffect(tx, {
        proposal_id: proposalId,
        principal: PRINCIPAL,
        adapter: createLocalEffectAdapter(),
      });
      assert.equal(result.status, 'DENIED');
      assert.ok(result.reason_codes.includes('NO_ACTIVE_GRANT'));
      assert.equal(result.claimed_success, false);
    });
  });
});
