// tests/v1.0c-write-safe.test.mjs
// V1.0C Write-Safe Foundation — gap-fill acceptance (current SOT numbering):
//   #9  owner session required for APPROVE
//   #11 exact session/principal binding always required for APPROVE
//   #27 PITR restore does not resurrect already-committed external effect
//   #28 no autonomous retry after ambiguity without idempotency+postcondition
//   #29 browser/Orgo fallback only after VERIFIED ABSENT
//   #32 single-flight tenant+subject+routine+stage
//   #33 cancelled/expired workflow cannot commit late effect
//   #34 semantic action dedupe
//
// Business-write autonomy remains DISABLED. local_fake only.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import { validateApproval } from '../src/contracts/approval.js';
import { insertCapability } from '../src/contracts/capability.js';
import { requestHash, idempotencyKey } from '../src/contracts/ids.js';
import {
  executeTrustedEffect,
  computeEffectIdempotencyKey,
} from '../src/runtime/trusted-executor.js';
import { createLocalEffectAdapter } from '../src/runtime/local-effect-adapter.js';
import {
  assertAutonomousRetryAllowedAfterAmbiguity,
  assertCrossSurfaceFallbackAllowed,
  EffectAmbiguityError,
} from '../src/runtime/effect-ambiguity.js';
import {
  acquireOrJoinDecisionFlight,
  cancelDecisionFlight,
  claimSemanticAction,
  assertWorkflowMayCommitEffect,
  SingleFlightError,
} from '../src/runtime/single-flight.js';
import { BUSINESS_WRITE_AUTONOMY } from '../src/runtime/autonomy.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const PRINCIPAL = 'principal-a';
const CAP_ID = 'cap.v1c.noop';
const CAP_UNSAFE = 'cap.v1c.unsafe';

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

async function seedGrant(tx, { capabilityId = CAP_ID } = {}) {
  const grantId = randomUUID();
  await tx.query(
    `INSERT INTO authority_grants (
       grant_id, tenant_id, principal, capability_action_scope, resource_scope,
       approval_mode, effective_at, issued_by, policy_version, revocation_epoch, status
     ) VALUES (
       $1, cur_tenant(), $2, $3::jsonb, '{}'::jsonb,
       'default', now(), 'owner', 'v1', 0, 'active'
     );`,
    [grantId, PRINCIPAL, JSON.stringify({ capability_ids: [capabilityId] })]
  );
  return grantId;
}

async function seedProposal(tx, overrides = {}) {
  const proposalId = overrides.proposal_id || randomUUID();
  const workflowId = overrides.workflow_id || randomUUID();
  const stepId = overrides.step_id || 'step-1';
  const capId = overrides.capability_id || CAP_ID;
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
    [proposalId, workflowId, stepId, capId, JSON.stringify(canonical), rh]
  );
  return {
    proposal_id: proposalId,
    workflow_id: workflowId,
    step_id: stepId,
    request_hash: rh,
    capability_id: capId,
  };
}

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/v1.0c-write-safe-test' });
  await seedTwoTenants(db, { aId: A, bId: B });
  await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
    await tx.query(
      `INSERT INTO authority_control (tenant_id, active_authority, revocation_epoch, kill_epoch)
       VALUES ($1, true, 0, 0);`,
      [A]
    );
    await insertCapability(tx, baseCap());
    await insertCapability(tx, baseCap({
      capability_id: CAP_UNSAFE,
      provider_idempotency: 'unknown',
      postcondition_observable: false,
      operation: 'unsafe_write',
    }));
    await seedGrant(tx, { capabilityId: CAP_ID });
    await seedGrant(tx, { capabilityId: CAP_UNSAFE });
  });
});

after(async () => {
  if (db) await db.close();
});

describe('V1.0C #9/#11 owner session binding for APPROVE', () => {
  test('9. APPROVE without authenticated owner session is invalid', () => {
    const proposal = {
      proposal_id: 'p1',
      request_hash: 'h1',
      precondition_snapshot_ref: null,
    };
    const approval = {
      proposal_id: 'p1',
      request_hash: 'h1',
      owner_principal_id: 'owner-1',
      owner_auth_session_id: 'sess-1',
      step_up_mfa_required: false,
      decision: 'APPROVE',
      consumed_at: null,
      expires_at: null,
      relevant_state_version: null,
    };
    const v = validateApproval({ approval, proposal, session: null, now: Date.now() });
    assert.equal(v.valid, false);
    assert.ok(v.reasons.some((r) => /no owner session/.test(r)));
  });

  test('11. APPROVE binds exact session even when step-up MFA is not required', () => {
    const now = Date.now();
    const proposal = {
      proposal_id: 'p2',
      request_hash: 'h2',
      precondition_snapshot_ref: null,
    };
    const approval = {
      proposal_id: 'p2',
      request_hash: 'h2',
      owner_principal_id: 'owner-1',
      owner_auth_session_id: 'sess-bound',
      step_up_mfa_required: false,
      decision: 'APPROVE',
      consumed_at: null,
      expires_at: null,
      relevant_state_version: null,
    };
    const bound = {
      session_id: 'sess-bound',
      owner_principal_id: 'owner-1',
      auth_strength: 'standard',
      session_expires_at: new Date(now + 60_000).toISOString(),
      revoked_at: null,
      step_up_verified_at: null,
      step_up_expires_at: null,
    };
    assert.equal(validateApproval({ approval, proposal, session: bound, now }).valid, true);

    const other = { ...bound, session_id: 'sess-other' };
    const v = validateApproval({ approval, proposal, session: other, now });
    assert.equal(v.valid, false);
    assert.ok(v.reasons.some((r) => /session_id does not match/.test(r)));
  });
});

describe('V1.0C #28/#29 ambiguous retry and browser/Orgo fallback', () => {
  test('28. unsafe capability cannot autonomously retry after ambiguity', () => {
    const unsafe = baseCap({
      capability_id: CAP_UNSAFE,
      provider_idempotency: 'unknown',
      postcondition_observable: false,
    });
    assert.throws(
      () => assertAutonomousRetryAllowedAfterAmbiguity(unsafe, {
        prior_outcome: 'AMBIGUOUS',
        prior_postcondition: 'UNKNOWN',
      }),
      (err) => err instanceof EffectAmbiguityError
        && err.code === 'AUTONOMOUS_RETRY_FORBIDDEN_AFTER_AMBIGUITY'
    );

    const safe = baseCap({ provider_idempotency: 'supported', postcondition_observable: true });
    const ok = assertAutonomousRetryAllowedAfterAmbiguity(safe, {
      prior_outcome: 'AMBIGUOUS',
      prior_postcondition: 'AMBIGUOUS',
    });
    assert.equal(ok.allowed, true);
  });

  test('28. executor denies retry_after_ambiguity for unsafe capability', async () => {
    assert.equal(BUSINESS_WRITE_AUTONOMY, false);
    const adapter = createLocalEffectAdapter();
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const p = await seedProposal(tx, {
        capability_id: CAP_UNSAFE,
        canonical_request: { op: 'unsafe', n: 7 },
      });
      const result = await executeTrustedEffect(tx, {
        proposal_id: p.proposal_id,
        principal: PRINCIPAL,
        adapter,
        retry_after_ambiguity: true,
        prior_outcome: 'AMBIGUOUS',
        prior_postcondition: 'UNKNOWN',
      });
      assert.equal(result.status, 'DENIED');
      // Unsafe caps elevate to APPROVAL_REQUIRED and/or block autonomous retry.
      assert.ok(
        result.reason_codes.includes('AUTONOMOUS_RETRY_FORBIDDEN_AFTER_AMBIGUITY')
          || result.reason_codes.includes('APPROVAL_REQUIRED')
          || result.reason_codes.some((c) => /AUTONOMOUS_RETRY|APPROVAL|POSTCONDITION/.test(c)),
        JSON.stringify(result.reason_codes)
      );
      assert.equal(result.claimed_success, false);
    });
  });

  test('29. browser/Orgo fallback forbidden unless prior effect VERIFIED ABSENT', () => {
    assert.throws(
      () => assertCrossSurfaceFallbackAllowed({
        prior_surface: 'api',
        fallback_surface: 'browser_orgo',
        postcondition_status: 'UNKNOWN',
        durable_evidence: true,
      }),
      (err) => err instanceof EffectAmbiguityError
        && err.code === 'BROWSER_ORGO_FALLBACK_FORBIDDEN'
    );
    assert.throws(
      () => assertCrossSurfaceFallbackAllowed({
        fallback_surface: 'browser',
        postcondition_status: 'VERIFIED_ABSENT',
        durable_evidence: false,
      }),
      (err) => err instanceof EffectAmbiguityError
        && err.code === 'FALLBACK_REQUIRES_DURABLE_POSTCONDITION'
    );
    const ok = assertCrossSurfaceFallbackAllowed({
      fallback_surface: 'orgo',
      postcondition_status: 'VERIFIED_ABSENT',
      durable_evidence: true,
    });
    assert.equal(ok.allowed, true);
  });

  test('29. executor denies browser_orgo fallback without ABSENT proof', async () => {
    const adapter = createLocalEffectAdapter();
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const p = await seedProposal(tx, { canonical_request: { op: 'fallback', n: 1 } });
      const result = await executeTrustedEffect(tx, {
        proposal_id: p.proposal_id,
        principal: PRINCIPAL,
        adapter,
        fallback_surface: 'browser_orgo',
        prior_postcondition: 'UNKNOWN',
      });
      assert.equal(result.status, 'DENIED');
      assert.ok(
        result.reason_codes.includes('BROWSER_ORGO_FALLBACK_FORBIDDEN')
          || result.reason_codes.includes('FALLBACK_REQUIRES_DURABLE_POSTCONDITION'),
        JSON.stringify(result.reason_codes)
      );
      assert.equal(result.claimed_success, false);
    });
  });
});

describe('V1.0C #32/#33/#34 single-flight and semantic dedupe', () => {
  test('32. two workflows cannot both hold ACTIVE flight for same key', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const wf1 = randomUUID();
      const wf2 = randomUUID();
      const key = {
        subject_ref: 'subj-sf-1',
        routine_id: 'routine.followup',
        logical_stage: 'decide',
      };
      const first = await acquireOrJoinDecisionFlight(tx, { ...key, workflow_id: wf1 });
      assert.equal(first.mode, 'acquired');
      assert.equal(first.flight.status, 'ACTIVE');

      const second = await acquireOrJoinDecisionFlight(tx, { ...key, workflow_id: wf2 });
      assert.equal(second.mode, 'joined');
      assert.equal(second.competing, true);
      assert.equal(second.flight.workflow_id, wf1);
    });
  });

  test('33. cancelled workflow cannot commit late effect', async () => {
    const adapter = createLocalEffectAdapter();
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const p = await seedProposal(tx, { canonical_request: { op: 'late', n: 3 } });
      await acquireOrJoinDecisionFlight(tx, {
        subject_ref: 'subj-late',
        routine_id: 'routine.late',
        logical_stage: 'commit',
        workflow_id: p.workflow_id,
      });
      await cancelDecisionFlight(tx, { workflow_id: p.workflow_id, reason: 'owner_cancel' });

      await assert.rejects(
        () => assertWorkflowMayCommitEffect(tx, { workflow_id: p.workflow_id }),
        (err) => err instanceof SingleFlightError && err.code === 'WORKFLOW_CANCELLED'
      );

      const result = await executeTrustedEffect(tx, {
        proposal_id: p.proposal_id,
        principal: PRINCIPAL,
        adapter,
        enforce_single_flight: true,
        subject_ref: 'subj-late',
        routine_id: 'routine.late',
        logical_stage: 'commit',
      });
      assert.equal(result.status, 'DENIED');
      assert.ok(result.reason_codes.includes('WORKFLOW_CANCELLED'));
      assert.equal(result.claimed_success, false);
    });
  });

  test('33. expired workflow cannot commit late effect', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const wf = randomUUID();
      const past = new Date(Date.now() - 60_000).toISOString();
      await acquireOrJoinDecisionFlight(tx, {
        subject_ref: 'subj-exp',
        routine_id: 'routine.exp',
        logical_stage: 'commit',
        workflow_id: wf,
        expires_at: past,
      });
      await assert.rejects(
        () => assertWorkflowMayCommitEffect(tx, { workflow_id: wf, now: new Date() }),
        (err) => err instanceof SingleFlightError && err.code === 'WORKFLOW_EXPIRED'
      );
    });
  });

  test('34. semantic action key blocks duplicate logical follow-up', async () => {
    const adapter = createLocalEffectAdapter();
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const wf1 = randomUUID();
      const wf2 = randomUUID();
      const claim1 = await claimSemanticAction(tx, {
        subject_ref: 'subj-sem',
        semantic_action_key: 'send_followup_v1',
        workflow_id: wf1,
      });
      assert.equal(claim1.claimed, true);
      assert.equal(claim1.duplicate, false);

      await assert.rejects(
        () => claimSemanticAction(tx, {
          subject_ref: 'subj-sem',
          semantic_action_key: 'send_followup_v1',
          workflow_id: wf2,
        }),
        (err) => err instanceof SingleFlightError && err.code === 'SEMANTIC_ACTION_DUPLICATE'
      );

      const p = await seedProposal(tx, {
        workflow_id: wf2,
        canonical_request: { op: 'followup', wording: 'different prose same logical action' },
      });
      const denied = await executeTrustedEffect(tx, {
        proposal_id: p.proposal_id,
        principal: PRINCIPAL,
        adapter,
        subject_ref: 'subj-sem',
        semantic_action_key: 'send_followup_v1',
      });
      assert.equal(denied.status, 'DENIED');
      assert.ok(denied.reason_codes.includes('SEMANTIC_ACTION_DUPLICATE'));
    });
  });
});

describe('V1.0C #27 PITR does not resurrect committed external effect', () => {
  test('27. restore losing local COMPLETED ledger resumes same idempotency key; no duplicate commit', async () => {
    const adapter = createLocalEffectAdapter();
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const p = await seedProposal(tx, { canonical_request: { op: 'pitr', n: 99 } });
      const keyBefore = computeEffectIdempotencyKey({
        tenant_id: A,
        workflow_id: p.workflow_id,
        step_id: p.step_id,
        capability_id: CAP_ID,
        request_hash: p.request_hash,
      });

      const first = await executeTrustedEffect(tx, {
        proposal_id: p.proposal_id,
        principal: PRINCIPAL,
        adapter,
      });
      assert.equal(first.status, 'SUCCEEDED');
      assert.equal(first.claimed_success, true);
      assert.equal(first.idempotency_key, keyBefore);
      assert.ok(adapter.hasCommitted(keyBefore));
      const commitToken = adapter.getCommitted(keyBefore).commit_token;

      // Simulate PITR that rewound local completion surfaces while external
      // commit remains. Receipts for the same logical key are also rewound.
      await tx.query(`DELETE FROM effect_ledger WHERE idempotency_key = $1;`, [keyBefore]);
      await tx.query(`DELETE FROM execution_receipts WHERE idempotency_key = $1;`, [keyBefore]);
      const gone = await tx.query(
        `SELECT count(*)::int AS n FROM effect_ledger WHERE idempotency_key = $1;`,
        [keyBefore]
      );
      assert.equal(gone.rows[0].n, 0);

      // Same logical inputs MUST regenerate the same key (no new key after PITR).
      const keyAfter = idempotencyKey({
        tenant_id: A,
        workflow_id: p.workflow_id,
        step_id: p.step_id,
        capability_id: CAP_ID,
        request_hash: p.request_hash,
      });
      assert.equal(keyAfter, keyBefore);

      const resumed = await executeTrustedEffect(tx, {
        proposal_id: p.proposal_id,
        principal: PRINCIPAL,
        adapter,
      });
      assert.equal(resumed.idempotency_key, keyBefore);
      assert.equal(resumed.claimed_success, true);
      assert.equal(adapter.getCommitted(keyBefore).commit_token, commitToken);
      // Adapter still has exactly one commit record for this key.
      assert.equal(adapter.hasCommitted(keyBefore), true);

      const rows = await tx.query(
        `SELECT count(*)::int AS n FROM effect_ledger WHERE idempotency_key = $1;`,
        [keyBefore]
      );
      assert.equal(rows.rows[0].n, 1);
    });
  });
});
