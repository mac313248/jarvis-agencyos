// tests/observability.test.mjs
// F-12 Observability acceptance:
//   #18 security/credential/authority/material financial/privacy/fault classes
//       cannot be SILENCED
//   #19 10,000 healthy/no-op events produce zero unnecessary strong-model wakes
//   #20 same unresolved state hash does not repeatedly notify
//
// Stop condition: non-silenceable class silenced.
// Business-write autonomy remains DISABLED.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import {
  BUSINESS_WRITE_AUTONOMY,
  LIVE_EXTERNAL_SIDE_EFFECTS,
  OBSERVABILITY,
  assertBusinessWriteAutonomyDisabled,
} from '../src/runtime/autonomy.js';
import {
  HEALTHY_NOOP_CLASSES,
  MATERIALITY_ACTIONS,
  NON_SILENCEABLE_CLASSES,
  ObservabilityError,
  computeAttentionStateHash,
  createExecutionTrace,
  createMaterialityRuntime,
  evaluateMateriality,
  isHealthyNoop,
  isNonSilenceable,
  linkReceiptToTrace,
  openOrRefreshAttentionItem,
  processEventBatch,
  resolveReceiptTrace,
} from '../src/runtime/observability.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/observability-test' });
  await seedTwoTenants(db, { aId: A, bId: B });
});

after(async () => { await db.close(); });

describe('F-12 autonomy + contract surface', () => {
  test('business-write autonomy remains DISABLED', () => {
    assert.equal(BUSINESS_WRITE_AUTONOMY, false);
    assert.equal(LIVE_EXTERNAL_SIDE_EFFECTS, false);
    assert.equal(OBSERVABILITY, true);
    assert.equal(assertBusinessWriteAutonomyDisabled(), true);
  });

  test('contract_metadata records AttentionItem v1', async () => {
    const r = await db.query(
      `SELECT contract_name, contract_version, schema_path
       FROM contract_metadata WHERE contract_name='AttentionItem';`
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].contract_version, 1);
    assert.match(r.rows[0].schema_path, /AttentionItem/);
    assert.match(r.rows[0].schema_path, /Non-silenceable/);
  });

  test('materiality action vocabulary is locked', () => {
    assert.deepEqual([...MATERIALITY_ACTIONS], ['SILENCE', 'BATCH', 'NOTIFY', 'WAKE']);
  });
});

describe('F-12 #18 non-silenceable classes cannot be SILENCED', () => {
  test('registry covers security/credential/authority/financial/privacy/fault classes', () => {
    const required = [
      'tenant_isolation_security',
      'credential_authentication_anomaly',
      'authority_permission_change',
      'kill_switch_fail_closed',
      'material_financial',
      'privacy_legal_opt_out',
      'unknown_ambiguous_customer_effect',
      'control_store_outage',
      'severe_production_fault',
    ];
    for (const c of required) {
      assert.equal(isNonSilenceable(c), true, c);
      assert.ok(NON_SILENCEABLE_CLASSES.includes(c), c);
    }
  });

  for (const eventClass of NON_SILENCEABLE_CLASSES) {
    test(`${eventClass}: deterministic policy never returns SILENCE`, () => {
      const d = evaluateMateriality({ event_class: eventClass });
      assert.notEqual(d.action, 'SILENCE');
      assert.equal(d.non_silenceable, true);
      assert.equal(d.attention_required, true);
      assert.ok(d.action === 'NOTIFY' || d.action === 'WAKE');
    });

    test(`${eventClass}: LLM SILENCE suggestion is blocked`, () => {
      const d = evaluateMateriality(
        { event_class: eventClass },
        { llmSuggestion: 'SILENCE' }
      );
      assert.notEqual(d.action, 'SILENCE');
      assert.equal(d.non_silenceable, true);
      assert.match(d.reason, /SILENCE blocked|non-silenceable/);
    });

    test(`${eventClass}: forceSilence throws NON_SILENCEABLE_SILENCED (stop)`, () => {
      assert.throws(
        () => evaluateMateriality({ event_class: eventClass }, { forceSilence: true }),
        (e) => e instanceof ObservabilityError && e.code === 'NON_SILENCEABLE_SILENCED'
      );
    });
  }

  test('caller cannot demote non_silenceable or owner visibility on open', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await assert.rejects(
        () => openOrRefreshAttentionItem(tx, {
          tenant_id: A,
          condition_key: 'sec.demote',
          event_class: 'tenant_isolation_security',
          non_silenceable: false,
          severity: 'INFO',
          owner_action_required: false,
          payload: { attempt: 1 },
        }),
        (e) => e instanceof ObservabilityError && e.code === 'NON_SILENCEABLE_SILENCED'
      );

      await assert.rejects(
        () => openOrRefreshAttentionItem(tx, {
          tenant_id: A,
          condition_key: 'sec.invisible',
          event_class: 'material_financial',
          owner_action_required: false,
          severity: 'HIGH',
          payload: { attempt: 1 },
        }),
        (e) => e instanceof ObservabilityError && e.code === 'NON_SILENCEABLE_SILENCED'
      );
    });
  });

  test('DB rejects silenced non-silenceable attention rows', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await assert.rejects(
        () => tx.query(
          `INSERT INTO attention_items (
             attention_id, tenant_id, condition_key, state_hash, severity,
             owner_action_required, event_class, non_silenceable, status
           ) VALUES (
             $1,$2,'db.silence.flag','hash1','HIGH',true,
             'tenant_isolation_security', false, 'open'
           );`,
          [randomUUID(), A]
        )
      );
      await assert.rejects(
        () => tx.query(
          `INSERT INTO attention_items (
             attention_id, tenant_id, condition_key, state_hash, severity,
             owner_action_required, event_class, non_silenceable, status
           ) VALUES (
             $1,$2,'db.silence.vis','hash2','INFO',false,
             'severe_production_fault', true, 'open'
           );`,
          [randomUUID(), A]
        )
      );
    });
  });

  test('non-silenceable events open owner-visible attention items', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      for (const eventClass of [
        'tenant_isolation_security',
        'material_financial',
        'privacy_legal_opt_out',
        'severe_production_fault',
      ]) {
        const decision = evaluateMateriality({ event_class: eventClass });
        assert.notEqual(decision.action, 'SILENCE');
        const { item, notified } = await openOrRefreshAttentionItem(tx, {
          tenant_id: A,
          condition_key: `attn:${eventClass}`,
          event_class: eventClass,
          non_silenceable: true,
          severity: decision.severity,
          payload: { once: true },
          now: '2026-08-10T15:00:00.000Z',
        });
        assert.equal(notified, true);
        assert.equal(item.non_silenceable, true);
        assert.equal(item.status, 'open');
        assert.equal(item.owner_action_required, true);
        assert.notEqual(item.severity, 'INFO');
      }
    });
  });
});

describe('F-12 #19 10k healthy/no-op events → zero strong-model wakes', () => {
  test('healthy/no-op classes are recognized', () => {
    for (const c of HEALTHY_NOOP_CLASSES) {
      assert.equal(isHealthyNoop(c), true);
      assert.equal(isNonSilenceable(c), false);
    }
  });

  test('10,000 healthy/no-op events produce zero strong-model wakes', () => {
    const runtime = createMaterialityRuntime();
    const events = [];
    const classes = [...HEALTHY_NOOP_CLASSES];
    for (let i = 0; i < 10_000; i += 1) {
      events.push({
        event_id: `e-${i}`,
        event_class: classes[i % classes.length],
        healthy: true,
        noop: true,
      });
    }
    const { metrics } = processEventBatch(events, runtime);
    assert.equal(metrics.events_processed, 10_000);
    assert.equal(metrics.strong_model_wakes, 0);
    assert.equal(metrics.silences, 10_000);
    assert.equal(metrics.notifications, 0);
  });

  test('LLM cannot escalate healthy/no-op events to WAKE', () => {
    for (const eventClass of HEALTHY_NOOP_CLASSES) {
      const d = evaluateMateriality(
        { event_class: eventClass },
        { llmSuggestion: 'WAKE' }
      );
      assert.equal(d.action, 'SILENCE');
      assert.equal(d.strong_model_wake, false);
      assert.match(d.reason, /llm escalation blocked/);
    }
  });

  test('mixed batch: only non-noop material classes may wake', () => {
    const runtime = createMaterialityRuntime();
    for (let i = 0; i < 1000; i += 1) {
      runtime.evaluate({ event_class: 'noop' });
    }
    runtime.evaluate({ event_class: 'severe_production_fault' });
    assert.equal(runtime.metrics.strong_model_wakes, 1);
    assert.equal(runtime.metrics.silences, 1000);
  });
});

describe('F-12 #20 same unresolved state hash does not repeatedly notify', () => {
  test('state hash is deterministic for identical unresolved payload', () => {
    const a = computeAttentionStateHash({
      condition_key: 'billing.overdue',
      subject_ref: 'sub-1',
      event_class: 'material_financial',
      payload: { amount: 100, currency: 'USD' },
    });
    const b = computeAttentionStateHash({
      condition_key: 'billing.overdue',
      subject_ref: 'sub-1',
      event_class: 'material_financial',
      payload: { currency: 'USD', amount: 100 },
    });
    assert.equal(a, b);
  });

  test('repeat open with same state_hash suppresses notification', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const fields = {
        tenant_id: A,
        condition_key: 'crm.conflict:c-42',
        event_class: 'unknown_ambiguous_customer_effect',
        non_silenceable: true,
        severity: 'HIGH',
        payload: { conflict: 'version-mismatch', subject: 'c-42' },
        now: '2026-08-10T16:00:00.000Z',
      };
      const first = await openOrRefreshAttentionItem(tx, fields);
      assert.equal(first.notified, true);
      assert.equal(first.item.notify_count, 1);

      const second = await openOrRefreshAttentionItem(tx, {
        ...fields,
        now: '2026-08-10T16:05:00.000Z',
      });
      assert.equal(second.notified, false);
      assert.equal(second.material_change, false);
      assert.equal(second.item.notify_count, 1);
      assert.equal(second.item.state_hash, first.item.state_hash);

      const third = await openOrRefreshAttentionItem(tx, {
        ...fields,
        now: '2026-08-10T16:10:00.000Z',
      });
      assert.equal(third.notified, false);
      assert.equal(third.item.notify_count, 1);
    });
  });

  test('changed state_hash on unresolved item re-notifies once', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const base = {
        tenant_id: A,
        condition_key: 'auth.anomaly:conn-9',
        event_class: 'credential_authentication_anomaly',
        non_silenceable: true,
        severity: 'CRITICAL',
        now: '2026-08-10T17:00:00.000Z',
      };
      const first = await openOrRefreshAttentionItem(tx, {
        ...base,
        payload: { failures: 1 },
      });
      assert.equal(first.item.notify_count, 1);

      const changed = await openOrRefreshAttentionItem(tx, {
        ...base,
        payload: { failures: 5 },
        now: '2026-08-10T17:01:00.000Z',
      });
      assert.equal(changed.notified, true);
      assert.equal(changed.material_change, true);
      assert.equal(changed.item.notify_count, 2);
      assert.notEqual(changed.item.state_hash, first.item.state_hash);

      const sameAgain = await openOrRefreshAttentionItem(tx, {
        ...base,
        payload: { failures: 5 },
        now: '2026-08-10T17:02:00.000Z',
      });
      assert.equal(sameAgain.notified, false);
      assert.equal(sameAgain.item.notify_count, 2);
    });
  });
});

describe('F-12 receipts/trace linkage', () => {
  test('create trace, link receipt, resolve joined view', async () => {
    const workflowId = randomUUID();
    const receiptId = randomUUID();
    const stepId = 'step.link-1';

    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const trace = await createExecutionTrace(tx, {
        tenant_id: A,
        workflow_id: workflowId,
        root_span: 'trusted_executor',
        attributes: { phase: 'F-12' },
      });

      await tx.query(
        `INSERT INTO execution_receipts (
           receipt_id, tenant_id, workflow_id, step_id, actor, capability_id,
           provider, operation, target_ref, idempotency_key, request_hash,
           revocation_epoch_at_commit, kill_epoch_at_commit, started_at,
           verification_status, retry_count, trace_id
         ) VALUES (
           $1,$2,$3,$4,'test','cap.read','local','observe','target:1',
           $5,'req-hash-1',0,0,now(),'VERIFIED',0,$6
         );`,
        [
          receiptId,
          A,
          workflowId,
          stepId,
          `idem-${receiptId}`,
          randomUUID(), // provisional; will be linked
        ]
      );

      const linked = await linkReceiptToTrace(tx, {
        receipt_id: receiptId,
        trace_id: trace.trace_id,
        tenant_id: A,
      });
      assert.equal(linked.trace_id, trace.trace_id);
      assert.equal(linked.receipt_id, receiptId);

      const resolved = await resolveReceiptTrace(tx, {
        receipt_id: receiptId,
        tenant_id: A,
      });
      assert.equal(resolved.trace_id, trace.trace_id);
      assert.ok(resolved.trace);
      assert.equal(resolved.trace.root_span, 'trusted_executor');
      assert.equal(resolved.trace.status, 'open');
      assert.equal(resolved.verification_status, 'VERIFIED');
    });
  });

  test('tenant B cannot resolve tenant A receipt/trace', async () => {
    const workflowId = randomUUID();
    const receiptId = randomUUID();
    let traceId;

    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const trace = await createExecutionTrace(tx, {
        tenant_id: A,
        workflow_id: workflowId,
      });
      traceId = trace.trace_id;
      await tx.query(
        `INSERT INTO execution_receipts (
           receipt_id, tenant_id, workflow_id, step_id, actor, capability_id,
           provider, operation, target_ref, idempotency_key, request_hash,
           revocation_epoch_at_commit, kill_epoch_at_commit, started_at,
           verification_status, retry_count, trace_id
         ) VALUES (
           $1,$2,$3,'s','test','cap','local','op','t',$4,'h',0,0,now(),'VERIFIED',0,$5
         );`,
        [receiptId, A, workflowId, `idem-${receiptId}`, traceId]
      );
    });

    await asRuntimeTenant(db, 'app_runtime', B, async (tx) => {
      await assert.rejects(
        () => resolveReceiptTrace(tx, { receipt_id: receiptId, tenant_id: B }),
        (e) => e instanceof ObservabilityError && e.code === 'RECEIPT_NOT_FOUND'
      );
      const traces = await tx.query(
        `SELECT count(*)::int n FROM execution_traces WHERE trace_id = $1;`,
        [traceId]
      );
      assert.equal(traces.rows[0].n, 0);
    });
  });
});
