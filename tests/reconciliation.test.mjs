// tests/reconciliation.test.mjs
// F-10 Materialized state / freshness / reconciliation acceptance:
//   #36 provider mismatch with no local pending effect safely repairs or escalates
//   #37 pending/ambiguous local effect is never auto-overwritten as drift
//   #38 stale source becomes STALE/UNKNOWN
//   #39 conflicting authoritative evidence becomes CONFLICTED
//
// Stop condition: ambiguous local effect overwritten as drift.
// Business-write autonomy remains DISABLED.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import {
  BUSINESS_WRITE_AUTONOMY,
  LIVE_EXTERNAL_SIDE_EFFECTS,
  assertBusinessWriteAutonomyDisabled,
} from '../src/runtime/autonomy.js';
import {
  AGING_RATIO,
  CONFLICT_STATUS_VALUES,
  FAIL_CLOSED_FRESHNESS,
  FRESHNESS_VALUES,
  ReconciliationError,
  applyReconciliation,
  buildCurrentStateRecord,
  computeFreshness,
  createReconciliationRuntime,
  detectSourceConflict,
  hasReliableObservationFreshness,
  inferFailClosedSourceStatus,
  isBlockingLocalEffect,
  reconcile,
} from '../src/runtime/reconciliation.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/reconciliation-test' });
  await seedTwoTenants(db, { aId: A, bId: B });
});

after(async () => { await db.close(); });

function baseLocal(overrides = {}) {
  const now = overrides.now ?? '2026-08-10T12:00:00.000Z';
  const {
    state_key = 'crm.contact:c-1',
    value = { name: 'Ada', status: 'active' },
    state_version = '1',
    observed_at = now,
    max_age_seconds = 3600,
    conflict_status = 'NONE',
    evidence_refs = ['ev-local-1'],
    freshness,
    source_status,
    ...rest
  } = overrides;
  return buildCurrentStateRecord({
    tenant_id: A,
    state_key,
    domain: 'crm',
    subject_ref: 'subject:c-1',
    value,
    state_version,
    source_system: 'local_projection',
    as_of: now,
    observed_at,
    verified_at: now,
    max_age_seconds,
    conflict_status,
    evidence_refs,
    freshness,
    source_status,
    now,
    ...rest,
  });
}

describe('F-10 autonomy posture', () => {
  test('business-write autonomy remains DISABLED', () => {
    assert.equal(BUSINESS_WRITE_AUTONOMY, false);
    assert.equal(LIVE_EXTERNAL_SIDE_EFFECTS, false);
    assert.equal(assertBusinessWriteAutonomyDisabled(), true);
  });

  test('CurrentStateRecord freshness/conflict enums match contract', () => {
    assert.deepEqual([...FRESHNESS_VALUES], [
      'FRESH', 'AGING', 'STALE', 'OFFLINE', 'CONFLICTED', 'UNKNOWN',
    ]);
    assert.deepEqual([...CONFLICT_STATUS_VALUES], [
      'NONE', 'PENDING_LOCAL_EFFECT', 'SOURCE_CONFLICT', 'UNKNOWN',
    ]);
  });

  test('createReconciliationRuntime requires trusted tenant (fail-closed)', () => {
    assert.throws(
      () => createReconciliationRuntime(db),
      (err) => err instanceof ReconciliationError && err.code === 'MISSING_TENANT_CONTEXT',
    );
  });
});

describe('F-10 freshness engine', () => {
  test('FRESH → AGING → STALE by age vs max_age_seconds', () => {
    const observed = Date.parse('2026-08-10T12:00:00.000Z');
    const maxAge = 1000;
    assert.equal(
      computeFreshness({ observed_at: observed, max_age_seconds: maxAge, now: observed + 100 }),
      'FRESH',
    );
    assert.equal(
      computeFreshness({
        observed_at: observed,
        max_age_seconds: maxAge,
        now: observed + (maxAge * AGING_RATIO + 1) * 1000,
      }),
      'AGING',
    );
    assert.equal(
      computeFreshness({
        observed_at: observed,
        max_age_seconds: maxAge,
        now: observed + (maxAge + 1) * 1000,
      }),
      'STALE',
    );
  });

  test('OFFLINE / CONFLICTED / UNKNOWN precedence', () => {
    assert.equal(computeFreshness({ source_status: 'OFFLINE' }), 'OFFLINE');
    assert.equal(
      computeFreshness({ conflict_status: 'PENDING_LOCAL_EFFECT', source_status: 'OFFLINE' }),
      'OFFLINE',
    );
    assert.equal(
      computeFreshness({
        observed_at: Date.now(),
        max_age_seconds: 10,
        conflict_status: 'SOURCE_CONFLICT',
      }),
      'CONFLICTED',
    );
    assert.equal(computeFreshness({}), 'UNKNOWN');
  });

  test('force_freshness cannot override OFFLINE/CONFLICTED/UNKNOWN/STALE to FRESH', () => {
    assert.deepEqual([...FAIL_CLOSED_FRESHNESS], [
      'OFFLINE', 'CONFLICTED', 'UNKNOWN', 'STALE',
    ]);

    assert.equal(
      computeFreshness({ source_status: 'OFFLINE', force_freshness: 'FRESH' }),
      'OFFLINE',
    );
    assert.equal(
      computeFreshness({ source_status: 'UNREACHABLE', force_freshness: 'FRESH' }),
      'OFFLINE',
    );
    assert.equal(
      computeFreshness({
        conflict_status: 'PENDING_LOCAL_EFFECT',
        force_freshness: 'FRESH',
      }),
      'CONFLICTED',
    );
    assert.equal(
      computeFreshness({
        conflict_status: 'SOURCE_CONFLICT',
        force_freshness: 'AGING',
      }),
      'CONFLICTED',
    );
    assert.equal(
      computeFreshness({ source_status: 'UNKNOWN', force_freshness: 'FRESH' }),
      'UNKNOWN',
    );
    assert.equal(
      computeFreshness({ source_status: 'STALE', force_freshness: 'FRESH' }),
      'STALE',
    );

    const observed = Date.parse('2026-08-10T12:00:00.000Z');
    assert.equal(
      computeFreshness({
        observed_at: observed,
        max_age_seconds: 60,
        now: observed + 120_000,
        force_freshness: 'FRESH',
      }),
      'STALE',
    );
    assert.equal(
      computeFreshness({
        observed_at: null,
        max_age_seconds: 60,
        force_freshness: 'FRESH',
      }),
      'UNKNOWN',
    );

    // Safe labels may still accept an explicit non-freshening override.
    assert.equal(
      computeFreshness({
        observed_at: observed,
        max_age_seconds: 3600,
        now: observed + 1000,
        force_freshness: 'AGING',
      }),
      'AGING',
    );
  });
});

describe('F-10 fail-closed missing provider freshness metadata', () => {
  test('hasReliableObservationFreshness requires observed_at and max_age', () => {
    assert.equal(hasReliableObservationFreshness({ value: { x: 1 } }), false);
    assert.equal(hasReliableObservationFreshness({
      observed_at: '2026-08-10T12:00:00.000Z',
    }), false);
    assert.equal(hasReliableObservationFreshness({
      observed_at: '2026-08-10T12:00:00.000Z',
      max_age_seconds: 60,
    }), true);
    assert.equal(hasReliableObservationFreshness({
      observed_at: '2026-08-10T12:00:00.000Z',
    }, 60), true);
    assert.equal(hasReliableObservationFreshness({
      observed_at: 'not-a-timestamp',
      max_age_seconds: 60,
    }), false);
  });

  test('missing observed_at refuses REPAIR and does not overwrite local value', () => {
    const localValue = { name: 'KeepLocal', status: 'active' };
    const local = baseLocal({ value: localValue });
    const decision = reconcile({
      localState: local,
      providerObservation: {
        value: { name: 'ProviderWins', status: 'clobber' },
        source_system: 'fake-provider',
        // deliberately no observed_at / as_of
        evidence_ref: 'ev-missing-meta',
        state_version: '99',
      },
      localEffect: null,
      now: '2026-08-10T12:05:00.000Z',
    });

    assert.equal(decision.action, 'ESCALATE');
    assert.equal(decision.value_overwritten, false);
    assert.equal(decision.next_state.freshness, 'UNKNOWN');
    assert.equal(decision.next_state.conflict_status, 'UNKNOWN');
    assert.deepEqual(decision.next_state.value, localValue);
    assert.notEqual(decision.next_state.state_version, '99');
    assert.equal(decision.next_state.source_system, 'local_projection');
  });

  test('missing observed_at with matching value still MARK_UNKNOWN without materializing as FRESH', () => {
    const local = baseLocal({ value: { qty: 1 } });
    const decision = reconcile({
      localState: local,
      providerObservation: {
        value: { qty: 1 },
        // no observed_at — must not invent now and treat as FRESH
      },
      now: '2026-08-10T12:05:00.000Z',
    });
    assert.equal(decision.action, 'MARK_UNKNOWN');
    assert.equal(decision.value_overwritten, false);
    assert.equal(decision.next_state.freshness, 'UNKNOWN');
    assert.deepEqual(decision.next_state.value, { qty: 1 });
  });

  test('null observed_at cannot silently repair provider value', () => {
    const local = baseLocal({ value: { keep: true } });
    const decision = reconcile({
      localState: local,
      providerObservation: {
        value: { keep: false },
        observed_at: null,
        as_of: null,
        max_age_seconds: 3600,
      },
      now: '2026-08-10T12:05:00.000Z',
    });
    assert.equal(decision.value_overwritten, false);
    assert.ok(['ESCALATE', 'MARK_UNKNOWN'].includes(decision.action));
    assert.equal(decision.next_state.freshness, 'UNKNOWN');
    assert.deepEqual(decision.next_state.value, { keep: true });
  });
});

describe('F-10 #36 provider mismatch with no local pending effect safely repairs or escalates', () => {
  test('safe repair updates projection when no pending local effect', async () => {
    const local = baseLocal({ value: { name: 'Ada', status: 'active' } });
    const decision = reconcile({
      localState: local,
      providerObservation: {
        value: { name: 'Ada', status: 'paused' },
        source_system: 'fake-provider',
        observed_at: '2026-08-10T12:05:00.000Z',
        as_of: '2026-08-10T12:05:00.000Z',
        evidence_ref: 'ev-provider-1',
        state_version: '2',
      },
      localEffect: null,
      now: '2026-08-10T12:05:00.000Z',
    });

    assert.equal(decision.action, 'REPAIR');
    assert.equal(decision.value_overwritten, true);
    assert.equal(decision.next_state.value.status, 'paused');
    assert.equal(decision.next_state.conflict_status, 'NONE');
    assert.ok(['FRESH', 'AGING'].includes(decision.next_state.freshness));

    const stateKey = `crm.contact:repair-${randomUUID()}`;
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query(
        `INSERT INTO current_state_records (
           state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
           source_system, as_of, observed_at, verified_at, max_age_seconds,
           freshness, conflict_status, evidence_refs
         ) VALUES ($1,$2,$3,'crm','subject:c-1',$4::jsonb,'1','local_projection',
                   $5,$5,$5,3600,'FRESH','NONE','[]'::jsonb);`,
        [randomUUID(), A, stateKey, JSON.stringify(local.value), '2026-08-10T12:00:00.000Z'],
      );

      const applied = await applyReconciliation(tx, {
        stateKey,
        decision: {
          ...decision,
          next_state: { ...decision.next_state, state_key: stateKey },
        },
      });
      assert.equal(applied.inserted, false);

      const row = (await tx.query(
        `SELECT value, freshness, conflict_status, state_version, source_system
           FROM current_state_records WHERE state_key=$1;`,
        [stateKey],
      )).rows[0];
      assert.equal(row.value.status, 'paused');
      assert.equal(row.conflict_status, 'NONE');
      assert.equal(row.source_system, 'fake-provider');
      assert.equal(row.state_version, '2');
    });
  });

  test('escalate path refuses overwrite when observation incomplete', () => {
    const now = '2026-08-10T12:05:00.000Z';
    const local = baseLocal({ value: { qty: 1 }, now });
    const decision = reconcile({
      localState: local,
      providerObservation: {
        value: { qty: 99 },
        incomplete: true,
        observed_at: now,
      },
      localEffect: null,
      now,
    });
    assert.equal(decision.action, 'ESCALATE');
    assert.equal(decision.value_overwritten, false);
    assert.deepEqual(decision.next_state.value, local.value);
    assert.equal(decision.next_state.freshness, 'UNKNOWN');
  });

  test('escalateOnMismatch keeps local value', () => {
    const now = '2026-08-10T12:05:00.000Z';
    const local = baseLocal({ value: { flag: true }, now });
    const decision = reconcile({
      localState: local,
      providerObservation: { value: { flag: false }, observed_at: now },
      escalateOnMismatch: true,
      now,
    });
    assert.equal(decision.action, 'ESCALATE');
    assert.equal(decision.value_overwritten, false);
    assert.equal(decision.next_state.value.flag, true);
  });
});

describe('F-10 #37 pending/ambiguous local effect is never auto-overwritten as drift', () => {
  test('pending local effect marks CONFLICTED and preserves value', () => {
    assert.equal(isBlockingLocalEffect({ status: 'PENDING' }), true);
    const local = baseLocal({ value: { balance: 10 } });
    const decision = reconcile({
      localState: local,
      providerObservation: {
        value: { balance: 0 },
        observed_at: '2026-08-10T12:05:00.000Z',
        source_system: 'fake-provider',
      },
      localEffect: { status: 'PENDING' },
    });
    assert.equal(decision.action, 'HOLD_CONFLICTED');
    assert.equal(decision.value_overwritten, false);
    assert.equal(decision.next_state.freshness, 'CONFLICTED');
    assert.equal(decision.next_state.conflict_status, 'PENDING_LOCAL_EFFECT');
    assert.deepEqual(decision.next_state.value, { balance: 10 });
  });

  test('ambiguous postcondition never overwritten as drift (persisted)', async () => {
    assert.equal(isBlockingLocalEffect({ postcondition_status: 'AMBIGUOUS' }), true);
    const stateKey = `crm.contact:ambig-${randomUUID()}`;
    const localValue = { name: 'KeepMe', status: 'pending-write' };

    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query(
        `INSERT INTO current_state_records (
           state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
           source_system, as_of, observed_at, max_age_seconds, freshness, conflict_status, evidence_refs
         ) VALUES ($1,$2,$3,'crm','subject:c-1',$4::jsonb,'1','local_projection',
                   now(), now(), 3600, 'FRESH', 'NONE', '[]'::jsonb);`,
        [randomUUID(), A, stateKey, JSON.stringify(localValue)],
      );

      const runtime = createReconciliationRuntime(db, { trustedTenantId: A });
      const result = await runtime.reconcileState(tx, {
        localState: baseLocal({ state_key: stateKey, value: localValue }),
        providerObservation: {
          value: { name: 'Clobber', status: 'provider-wins' },
          observed_at: new Date().toISOString(),
        },
        localEffect: { status: 'COMMITTED', postcondition_status: 'AMBIGUOUS' },
        autoLoadLocalEffect: false,
      });

      assert.equal(result.decision.action, 'HOLD_CONFLICTED');
      assert.equal(result.decision.value_overwritten, false);

      const row = (await tx.query(
        `SELECT value, freshness, conflict_status FROM current_state_records WHERE state_key=$1;`,
        [stateKey],
      )).rows[0];
      assert.deepEqual(row.value, localValue);
      assert.equal(row.freshness, 'CONFLICTED');
      assert.equal(row.conflict_status, 'PENDING_LOCAL_EFFECT');
    });
  });

  test('applyReconciliation stop-condition rejects HOLD that would overwrite value', async () => {
    const stateKey = `crm.contact:stop-${randomUUID()}`;
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query(
        `INSERT INTO current_state_records (
           state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
           source_system, as_of, observed_at, max_age_seconds, freshness, conflict_status, evidence_refs
         ) VALUES ($1,$2,$3,'crm','subject:c-1','{"x":1}'::jsonb,'1','local_projection',
                   now(), now(), 3600, 'FRESH', 'NONE', '[]'::jsonb);`,
        [randomUUID(), A, stateKey],
      );

      await assert.rejects(
        () => applyReconciliation(tx, {
          stateKey,
          decision: {
            action: 'HOLD_CONFLICTED',
            value_overwritten: false,
            next_state: baseLocal({ state_key: stateKey, value: { x: 999 } }),
          },
        }),
        (err) => err instanceof ReconciliationError && err.code === 'STOP_CONDITION',
      );

      const row = (await tx.query(
        `SELECT value FROM current_state_records WHERE state_key=$1;`,
        [stateKey],
      )).rows[0];
      assert.deepEqual(row.value, { x: 1 });
    });
  });
});

describe('F-10 #38 stale source becomes STALE/UNKNOWN', () => {
  test('age beyond max_age_seconds → STALE', () => {
    const local = baseLocal({
      observed_at: '2026-08-10T10:00:00.000Z',
      max_age_seconds: 60,
    });
    const decision = reconcile({
      localState: local,
      providerObservation: null,
      now: '2026-08-10T12:00:00.000Z',
    });
    assert.equal(decision.action, 'MARK_STALE');
    assert.equal(decision.next_state.freshness, 'STALE');
    assert.equal(decision.value_overwritten, false);
  });

  test('provider STALE observation → STALE without overwrite', () => {
    const local = baseLocal({ value: { keep: true } });
    const decision = reconcile({
      localState: local,
      providerObservation: {
        value: { keep: false },
        source_status: 'STALE',
        observed_at: '2026-08-01T00:00:00.000Z',
      },
      now: '2026-08-10T12:00:00.000Z',
    });
    assert.equal(decision.action, 'MARK_STALE');
    assert.equal(decision.next_state.freshness, 'STALE');
    assert.deepEqual(decision.next_state.value, { keep: true });
  });

  test('UNKNOWN source → UNKNOWN', () => {
    const local = baseLocal();
    const decision = reconcile({
      localState: local,
      providerObservation: {
        value: local.value,
        source_status: 'UNKNOWN',
        observed_at: '2026-08-10T12:00:00.000Z',
      },
    });
    assert.equal(decision.action, 'MARK_UNKNOWN');
    assert.equal(decision.next_state.freshness, 'UNKNOWN');
  });

  test('OFFLINE source → OFFLINE', () => {
    const decision = reconcile({
      localState: baseLocal({ source_status: 'OFFLINE' }),
      providerObservation: null,
    });
    assert.equal(decision.next_state.freshness, 'OFFLINE');
    assert.equal(decision.next_state.source_status, 'OFFLINE');
  });

  test('OFFLINE then no-provider reconcile stays OFFLINE/UNKNOWN (never FRESH)', () => {
    const t1 = '2026-08-10T12:00:00.000Z';
    const t2 = '2026-08-10T12:00:30.000Z';
    const first = reconcile({
      localState: baseLocal({ source_status: 'OFFLINE', now: t1 }),
      providerObservation: null,
      now: t1,
    });
    assert.equal(first.next_state.freshness, 'OFFLINE');
    assert.equal(first.next_state.source_status, 'OFFLINE');
    assert.equal(first.next_state.observed_at, t1);

    // In-memory carry: next_state includes source_status.
    const second = reconcile({
      localState: first.next_state,
      providerObservation: null,
      now: t2,
    });
    assert.ok(['OFFLINE', 'UNKNOWN'].includes(second.next_state.freshness));
    assert.notEqual(second.next_state.freshness, 'FRESH');
    assert.notEqual(second.next_state.freshness, 'AGING');

    // DB-shaped carry: only freshness persisted (no source_status column).
    const { source_status: _drop, ...dbShaped } = first.next_state;
    assert.equal(dbShaped.source_status, undefined);
    assert.equal(inferFailClosedSourceStatus(dbShaped), 'OFFLINE');
    const third = reconcile({
      localState: dbShaped,
      providerObservation: null,
      now: t2,
    });
    assert.ok(['OFFLINE', 'UNKNOWN'].includes(third.next_state.freshness));
    assert.notEqual(third.next_state.freshness, 'FRESH');
  });

  test('UNKNOWN then no-provider reconcile stays UNKNOWN/CONFLICTED (never FRESH)', () => {
    const t1 = '2026-08-10T12:00:00.000Z';
    const t2 = '2026-08-10T12:00:30.000Z';
    const first = reconcile({
      localState: baseLocal({ now: t1 }),
      providerObservation: {
        value: { name: 'Ada', status: 'active' },
        source_status: 'UNKNOWN',
        observed_at: t1,
      },
      now: t1,
    });
    assert.equal(first.action, 'MARK_UNKNOWN');
    assert.equal(first.next_state.freshness, 'UNKNOWN');
    assert.equal(first.next_state.source_status, 'UNKNOWN');
    assert.equal(first.next_state.observed_at, t1);

    const second = reconcile({
      localState: first.next_state,
      providerObservation: null,
      now: t2,
    });
    assert.ok(['UNKNOWN', 'CONFLICTED'].includes(second.next_state.freshness));
    assert.notEqual(second.next_state.freshness, 'FRESH');
    assert.notEqual(second.next_state.freshness, 'AGING');

    const { source_status: _drop, ...dbShaped } = first.next_state;
    assert.equal(inferFailClosedSourceStatus(dbShaped), 'UNKNOWN');
    const third = reconcile({
      localState: dbShaped,
      providerObservation: null,
      now: t2,
    });
    assert.ok(['UNKNOWN', 'CONFLICTED'].includes(third.next_state.freshness));
    assert.notEqual(third.next_state.freshness, 'FRESH');
  });
});

describe('F-10 #39 conflicting authoritative evidence becomes CONFLICTED', () => {
  test('detectSourceConflict on disagreeing authoritative evidence', () => {
    assert.equal(
      detectSourceConflict(
        { authoritative: true, state_key: 'k', value: { a: 1 }, source_system: 's1', evidence_ref: 'e1' },
        { authoritative: true, state_key: 'k', value: { a: 2 }, source_system: 's2', evidence_ref: 'e2' },
      ),
      true,
    );
    assert.equal(
      detectSourceConflict(
        { authoritative: true, state_key: 'k', value: { a: 1 }, source_system: 's1', evidence_ref: 'e1' },
        { authoritative: true, state_key: 'k', value: { a: 1 }, source_system: 's1', evidence_ref: 'e1' },
      ),
      false,
    );
  });

  test('conflicting authoritative evidence → CONFLICTED / SOURCE_CONFLICT, value preserved', async () => {
    const stateKey = `crm.contact:conflict-${randomUUID()}`;
    const localValue = { stage: 'qualified' };

    const decision = reconcile({
      localState: baseLocal({
        state_key: stateKey,
        value: localValue,
        evidence_refs: ['ev-a'],
      }),
      conflictingEvidence: {
        authoritative: true,
        state_key: stateKey,
        value: { stage: 'disqualified' },
        source_system: 'other-authoritative',
        evidence_ref: 'ev-b',
      },
      providerObservation: {
        value: { stage: 'disqualified' },
        observed_at: '2026-08-10T12:05:00.000Z',
      },
    });

    assert.equal(decision.action, 'HOLD_CONFLICTED');
    assert.equal(decision.next_state.freshness, 'CONFLICTED');
    assert.equal(decision.next_state.conflict_status, 'SOURCE_CONFLICT');
    assert.equal(decision.value_overwritten, false);
    assert.deepEqual(decision.next_state.value, localValue);

    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query(
        `INSERT INTO current_state_records (
           state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
           source_system, as_of, observed_at, max_age_seconds, freshness, conflict_status, evidence_refs
         ) VALUES ($1,$2,$3,'crm','subject:c-1',$4::jsonb,'1','local_projection',
                   now(), now(), 3600, 'FRESH', 'NONE', '["ev-a"]'::jsonb);`,
        [randomUUID(), A, stateKey, JSON.stringify(localValue)],
      );
      await applyReconciliation(tx, { stateKey, decision });
      const row = (await tx.query(
        `SELECT value, freshness, conflict_status FROM current_state_records WHERE state_key=$1;`,
        [stateKey],
      )).rows[0];
      assert.deepEqual(row.value, localValue);
      assert.equal(row.freshness, 'CONFLICTED');
      assert.equal(row.conflict_status, 'SOURCE_CONFLICT');
    });
  });
});
