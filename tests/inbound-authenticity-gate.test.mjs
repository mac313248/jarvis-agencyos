// tests/inbound-authenticity-gate.test.mjs
// Fail-closed inbound-event authenticity gate acceptance:
//   A) verified accepted
//   B) unsigned/missing rejected
//   C) failed rejected
//   D) unknown source rejected
//   E) rejected never reaches canonical materialization
//   F) existing valid behavior remains passing
// Codex review regressions:
//   G) caller-supplied connector object must not authorize materialization
//   H) caller-asserted inbound.verification claims must not authorize materialization

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import { insertConnector } from '../src/contracts/connector.js';
import {
  canMaterializeCanonicalState,
  fakeProviderAdapter,
} from '../src/contracts/events.js';
import {
  evaluateInboundAuthenticityGate,
  processInboundEvent,
  verifyInboundSignature,
  INBOUND_AUTHENTICITY_GATE_VERSION,
  TRUSTED_FAKE_SIGNATURE_HEADER,
} from '../src/runtime/inbound-authenticity-gate.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const CONNECTOR_ID = 'conn.inbound.fake';
const SOURCE = 'fake-provider';

function baseConnector(overrides = {}) {
  return {
    contract_version: 1,
    connector_id: CONNECTOR_ID,
    provider: SOURCE,
    control_surface: 'api',
    adapter: 'fake.inbound',
    access_mode: 'read_only',
    capability_ids: ['cap.fixture.read'],
    credential_broker_ref: 'credbroker://vault/fake-inbound',
    authenticity_verification_ref: 'authver://fake/hmac-sha256',
    auth_scope: { scopes: ['webhook'] },
    network_scope: { allow: [] },
    status: 'active',
    ...overrides,
  };
}

function baseInbound(overrides = {}) {
  return {
    event_type: 'provider.payment.received',
    source_system: SOURCE,
    connector_id: CONNECTOR_ID,
    dedupe_key: 'dedupe-' + randomUUID(),
    content_trust: 'TRUSTED_STRUCTURED',
    verification_input: { signature_header: TRUSTED_FAKE_SIGNATURE_HEADER },
    typed_properties: { amount_cents: 1000 },
    materialization: {
      state_key: 'payment:acct-1',
      domain: 'payments',
      subject_ref: 'acct-1',
      value: { status: 'received', amount_cents: 1000 },
      state_version: 'v1',
      max_age_seconds: 3600,
    },
    ...overrides,
  };
}

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/inbound-gate-test' });
  await seedTwoTenants(db, { aId: A });
  await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
    await insertConnector(tx, baseConnector());
  });
});

after(async () => { await db.close(); });

describe('inbound authenticity gate — explicit gate before materialization', () => {
  test('A. verified inbound event is accepted and materializes canonical state', async () => {
    const inbound = baseInbound();
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      processInboundEvent(tx, inbound));

    assert.equal(result.gate.accepted, true);
    assert.equal(result.gate.may_materialize, true);
    assert.equal(result.materialized, true);
    assert.equal(result.gate.authenticity_status, 'VERIFIED');
    assert.equal(result.gate.rejection_reason, null);
    assert.equal(result.gate.evidence.gate_version, INBOUND_AUTHENTICITY_GATE_VERSION);
    assert.equal(result.gate.evidence.source_system, SOURCE);
    assert.equal(result.gate.evidence.provider, SOURCE);
    assert.equal(result.gate.evidence.verification_result, 'VERIFIED');

    const eventRow = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT materialized_state, authenticity_status FROM canonical_events WHERE event_id=$1;',
        [result.event_id]
      )).rows[0]);
    assert.equal(eventRow.materialized_state, true);
    assert.equal(eventRow.authenticity_status, 'VERIFIED');

    const stateCount = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT count(*)::int n FROM current_state_records WHERE last_event_id=$1;',
        [result.event_id]
      )).rows[0].n);
    assert.equal(stateCount, 1);
  });

  test('B. unsigned/missing signature is rejected (UNKNOWN)', async () => {
    const inbound = baseInbound({
      verification_input: {},
      dedupe_key: 'dedupe-missing-' + randomUUID(),
    });
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      processInboundEvent(tx, inbound));

    assert.equal(result.gate.accepted, false);
    assert.equal(result.gate.may_materialize, false);
    assert.equal(result.gate.authenticity_status, 'UNKNOWN');
    assert.ok(result.gate.rejection_reason);
    assert.equal(result.gate.evidence.verification_result, 'UNKNOWN');

    const eventRow = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT materialized_state FROM canonical_events WHERE event_id=$1;',
        [result.event_id]
      )).rows[0]);
    assert.equal(eventRow.materialized_state, false);
  });

  test('C. failed signature verification is rejected (FAILED)', async () => {
    const inbound = baseInbound({
      verification_input: { signature_header: 'bad-signature' },
      dedupe_key: 'dedupe-failed-' + randomUUID(),
    });
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      processInboundEvent(tx, inbound));

    assert.equal(result.gate.accepted, false);
    assert.equal(result.gate.may_materialize, false);
    assert.equal(result.gate.authenticity_status, 'FAILED');
    assert.match(result.gate.rejection_reason, /failed/i);
    assert.equal(result.gate.evidence.verification_result, 'FAILED');
  });

  test('D. unknown source / unregistered connector is rejected', async () => {
    const gateOnly = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      evaluateInboundAuthenticityGate(tx, {
        event_type: 'provider.payment.received',
        source_system: 'unknown-vendor',
        connector_id: 'conn.does-not-exist',
        verification_input: { signature_header: TRUSTED_FAKE_SIGNATURE_HEADER },
      }));
    assert.equal(gateOnly.accepted, false);
    assert.equal(gateOnly.authenticity_status, 'UNKNOWN');
    assert.match(gateOnly.rejection_reason, /unknown/i);

    const inbound = baseInbound({
      source_system: 'unknown-vendor',
      connector_id: 'conn.does-not-exist',
      dedupe_key: 'dedupe-unknown-src-' + randomUUID(),
    });
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      processInboundEvent(tx, inbound));
    assert.equal(result.materialized, false);
    assert.match(result.gate.evidence.rejection_reason, /unknown/i);
  });

  test('E. rejected events never reach canonical state materialization', async () => {
    const cases = [
      baseInbound({
        verification_input: {},
        dedupe_key: 'dedupe-e-missing-' + randomUUID(),
      }),
      baseInbound({
        verification_input: { signature_header: 'bad-signature' },
        dedupe_key: 'dedupe-e-failed-' + randomUUID(),
      }),
      baseInbound({
        source_connection_id: undefined,
        connector_id: 'conn.missing',
        dedupe_key: 'dedupe-e-unknown-' + randomUUID(),
      }),
    ];

    for (const inbound of cases) {
      const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
        processInboundEvent(tx, inbound));
      assert.equal(result.materialized, false, `expected no materialization for ${inbound.dedupe_key}`);

      const stateCount = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
        (await tx.query(
          'SELECT count(*)::int n FROM current_state_records WHERE last_event_id=$1;',
          [result.event_id]
        )).rows[0].n);
      assert.equal(stateCount, 0, `current_state must not exist for rejected ${inbound.dedupe_key}`);

      const eventRow = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
        (await tx.query(
          `SELECT materialized_state, typed_properties->'_inbound_authenticity_gate' AS gate
           FROM canonical_events WHERE event_id=$1;`,
          [result.event_id]
        )).rows[0]);
      assert.equal(eventRow.materialized_state, false);
      assert.ok(eventRow.gate, 'gate evidence preserved on rejected event');
      assert.equal(eventRow.gate.source_system, inbound.source_system);
      assert.ok(eventRow.gate.verification_result);
      assert.ok(eventRow.gate.rejection_reason);
    }
  });

  test('F. existing contracts-auth authenticity behavior remains passing', () => {
    const verified = fakeProviderAdapter({ signaturePresent: true, signatureValid: true });
    assert.equal(verified.authenticity_status, 'VERIFIED');

    let r = canMaterializeCanonicalState({
      event_type: 'provider.payment.received',
      authenticity_status: 'VERIFIED',
      content_trust: 'TRUSTED_STRUCTURED',
    });
    assert.equal(r.mayMaterialize, true);

    r = canMaterializeCanonicalState({
      event_type: 'provider.payment.received',
      authenticity_status: 'FAILED',
      content_trust: 'UNTRUSTED_PAYLOAD',
    });
    assert.equal(r.mayMaterialize, false);

    r = canMaterializeCanonicalState({
      event_type: 'internal.tick',
      authenticity_status: 'NOT_APPLICABLE',
      content_trust: 'TRUSTED_STRUCTURED',
    });
    assert.equal(r.mayMaterialize, true);

    const sig = verifyInboundSignature({
      connector: baseConnector(),
      verification_input: { signature_header: TRUSTED_FAKE_SIGNATURE_HEADER },
    });
    assert.equal(sig.authenticity_status, 'VERIFIED');
    assert.equal(sig.rejection_reason, null);
  });

  test('G. caller-supplied connector object cannot bypass registry (finding 1)', async () => {
    const inbound = baseInbound({
      connector_id: 'conn.does-not-exist',
      connector: baseConnector({
        connector_id: 'conn.does-not-exist',
        status: 'active',
        authenticity_verification_ref: 'authver://fake/hmac-sha256',
      }),
      verification_input: { signature_header: TRUSTED_FAKE_SIGNATURE_HEADER },
      dedupe_key: 'dedupe-fake-connector-' + randomUUID(),
    });

    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      processInboundEvent(tx, inbound));

    assert.equal(result.gate.accepted, false);
    assert.equal(result.materialized, false);
    assert.match(result.gate.rejection_reason, /unknown/i);
  });

  test('H. caller-asserted inbound.verification claims are rejected (finding 2)', async () => {
    const gateOnly = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      evaluateInboundAuthenticityGate(tx, {
        event_type: 'provider.payment.received',
        source_system: SOURCE,
        connector_id: CONNECTOR_ID,
        verification: { signaturePresent: true, signatureValid: true },
        dedupe_key: 'dedupe-untrusted-verification-' + randomUUID(),
      }));
    assert.equal(gateOnly.accepted, false);
    assert.equal(gateOnly.may_materialize, false);
    assert.match(gateOnly.rejection_reason, /untrusted inbound\.verification/i);

    const inbound = baseInbound({
      verification: { signaturePresent: true, signatureValid: true },
      verification_input: {},
      dedupe_key: 'dedupe-untrusted-verification-process-' + randomUUID(),
    });
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      processInboundEvent(tx, inbound));

    assert.equal(result.gate.accepted, false);
    assert.equal(result.materialized, false);
    assert.match(result.gate.rejection_reason, /untrusted inbound\.verification/i);
  });
});

describe('inbound authenticity gate — non-auth-required passthrough', () => {
  test('internal events bypass auth gate with NOT_APPLICABLE', async () => {
    const inbound = {
      event_type: 'internal.tick',
      source_system: 'agencyos',
      dedupe_key: 'dedupe-internal-' + randomUUID(),
      content_trust: 'TRUSTED_STRUCTURED',
      materialization: {
        state_key: 'internal:tick',
        domain: 'system',
        subject_ref: 'system',
        value: { tick: 1 },
        state_version: '1',
        max_age_seconds: 60,
      },
    };
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      processInboundEvent(tx, inbound));
    assert.equal(result.gate.authenticity_status, 'NOT_APPLICABLE');
    assert.equal(result.materialized, true);
  });
});
