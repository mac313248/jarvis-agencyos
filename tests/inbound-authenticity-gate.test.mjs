// tests/inbound-authenticity-gate.test.mjs
// Fail-closed inbound-event authenticity gate acceptance:
//   A) verified accepted
//   B) unsigned/missing rejected
//   C) failed rejected
//   D) unknown source rejected
//   E) rejected never reaches canonical materialization
//   F) existing valid behavior remains passing (contracts-auth regression)
//
// SOT: 07_AUTHORITY_SECURITY_EXECUTION.md#Inbound-authenticity
//      06_SYSTEM_CONTRACTS.md#CanonicalEvent

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import { insertConnector } from '../src/contracts/connector.js';
import {
  INBOUND_AUTHENTICITY_GATE_CONTRACT_VERSION,
  runInboundAuthenticityGate,
  resolveInboundSource,
  ingestInboundEvent,
} from '../src/runtime/inbound-authenticity-gate.js';
import {
  canMaterializeCanonicalState,
  fakeProviderAdapter,
} from '../src/contracts/events.js';
import { assertBusinessWriteAutonomyDisabled } from '../src/runtime/autonomy.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';

function baseConnector(overrides = {}) {
  return {
    contract_version: 1,
    connector_id: 'conn.inbound.fixture',
    provider: 'fixture-provider',
    control_surface: 'api',
    adapter: 'fixture.read_only',
    access_mode: 'read_only',
    capability_ids: ['cap.fixture.read'],
    credential_broker_ref: 'credbroker://vault/inbound-fixture',
    authenticity_verification_ref: 'authver://hmac/inbound-fixture',
    auth_scope: { scopes: ['read'] },
    network_scope: { allow: [] },
    status: 'active',
    ...overrides,
  };
}

function inboundEnvelope(overrides = {}) {
  return {
    event_type: 'provider.payment.received',
    source_system: 'fixture-provider',
    provider: 'fixture-provider',
    source_connection_id: 'conn.inbound.fixture',
    dedupe_key: `dedupe-${randomUUID()}`,
    signaturePresent: true,
    signatureValid: true,
    typed_properties: { amount_cents: 1000 },
    subject_refs: ['payment-1'],
    ...overrides,
  };
}

before(async () => {
  db = await freshCluster({ unique: 'inbound-authenticity-gate' });
  await seedTwoTenants(db, { aId: A });
  await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
    await insertConnector(tx, baseConnector());
  });
});

after(async () => {
  if (db) await db.close();
});

describe('inbound authenticity gate contract surface', () => {
  test('contract_metadata records InboundAuthenticityGate v1', async () => {
    const r = await db.query(
      `SELECT contract_name, contract_version, schema_path
         FROM contract_metadata
        WHERE contract_name = 'InboundAuthenticityGate';`
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].contract_version, 1);
    assert.match(r.rows[0].schema_path, /CanonicalEvent/);
    assert.match(r.rows[0].schema_path, /Inbound-authenticity/);
  });

  test('business-write autonomy remains DISABLED', () => {
    assert.equal(assertBusinessWriteAutonomyDisabled(), true);
  });
});

describe('A) verified inbound event is accepted and may materialize', () => {
  test('gate accepts verified auth-required event from known connector', async () => {
    const resolution = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      resolveInboundSource(tx, {
        source_connection_id: 'conn.inbound.fixture',
        provider: 'fixture-provider',
      })
    );
    assert.equal(resolution.found, true);

    const gate = runInboundAuthenticityGate({
      event_type: 'provider.payment.received',
      source_system: 'fixture-provider',
      provider: 'fixture-provider',
      source_connection_id: 'conn.inbound.fixture',
      signaturePresent: true,
      signatureValid: true,
      connectorResolution: resolution,
    });

    assert.equal(gate.accepted, true);
    assert.equal(gate.verification_result, 'ACCEPTED');
    assert.equal(gate.authenticity_status, 'VERIFIED');
    assert.equal(gate.rejection_reason, null);
    assert.equal(gate.evidence.provider, 'fixture-provider');
    assert.equal(gate.evidence.verification_result, 'ACCEPTED');
  });

  test('ingest persists canonical event with materialized_state=true and updates current_state', async () => {
    const stateKey = `payment.${randomUUID()}`;
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      ingestInboundEvent(tx, inboundEnvelope({ dedupe_key: `dedupe-a-${randomUUID()}` }), {
        materialization: {
          state_key: stateKey,
          domain: 'payments',
          subject_ref: 'payment-subject-a',
          value: { status: 'received', amount_cents: 1000 },
        },
      })
    );

    assert.equal(result.duplicate, false);
    assert.equal(result.accepted, true);
    assert.equal(result.materialized, true);
    assert.ok(result.event_id);
    assert.ok(result.state_id);

    const event = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        `SELECT authenticity_status, materialized_state, typed_properties
           FROM canonical_events WHERE event_id = $1;`,
        [result.event_id]
      )).rows[0]
    );
    assert.equal(event.authenticity_status, 'VERIFIED');
    assert.equal(event.materialized_state, true);
    assert.equal(
      event.typed_properties.inbound_authenticity_gate.contract_version,
      INBOUND_AUTHENTICITY_GATE_CONTRACT_VERSION
    );
    assert.equal(event.typed_properties.inbound_authenticity_gate.verification_result, 'ACCEPTED');

    const state = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        `SELECT last_event_id, value
           FROM current_state_records WHERE state_key = $1;`,
        [stateKey]
      )).rows[0]
    );
    assert.equal(state.last_event_id, result.event_id);
    assert.equal(state.value.status, 'received');
  });
});

describe('B) unsigned/missing signature is rejected', () => {
  test('gate rejects missing signature on auth-required event', () => {
    const gate = runInboundAuthenticityGate({
      event_type: 'provider.payment.received',
      source_system: 'fixture-provider',
      provider: 'fixture-provider',
      source_connection_id: 'conn.inbound.fixture',
      signaturePresent: false,
      signatureValid: false,
      connectorResolution: { found: true, connector: baseConnector(), reason: null },
    });

    assert.equal(gate.accepted, false);
    assert.equal(gate.authenticity_status, 'UNKNOWN');
    assert.equal(gate.verification_result, 'REJECTED');
    assert.equal(gate.rejection_reason, 'authenticity_unknown');
    assert.equal(gate.evidence.rejection_reason, 'authenticity_unknown');
  });

  test('ingest rejects unsigned event without materializing state', async () => {
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      ingestInboundEvent(tx, inboundEnvelope({
        dedupe_key: `dedupe-b-${randomUUID()}`,
        signaturePresent: false,
        signatureValid: false,
      }), {
        materialization: {
          state_key: `payment.${randomUUID()}`,
          domain: 'payments',
          subject_ref: 'payment-subject-b',
          value: { status: 'received' },
        },
      })
    );

    assert.equal(result.accepted, false);
    assert.equal(result.materialized, false);
    assert.equal(result.state_id, null);

    const event = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        `SELECT materialized_state, typed_properties
           FROM canonical_events WHERE event_id = $1;`,
        [result.event_id]
      )).rows[0]
    );
    assert.equal(event.materialized_state, false);
    assert.equal(event.typed_properties.inbound_authenticity_gate.verification_result, 'REJECTED');
  });
});

describe('C) failed verification is rejected', () => {
  test('gate rejects invalid signature', () => {
    const gate = runInboundAuthenticityGate({
      event_type: 'provider.payment.received',
      source_system: 'fixture-provider',
      provider: 'fixture-provider',
      source_connection_id: 'conn.inbound.fixture',
      signaturePresent: true,
      signatureValid: false,
      connectorResolution: { found: true, connector: baseConnector(), reason: null },
    });

    assert.equal(gate.accepted, false);
    assert.equal(gate.authenticity_status, 'FAILED');
    assert.equal(gate.verification_result, 'REJECTED');
    assert.equal(gate.rejection_reason, 'authenticity_failed');
  });

  test('ingest rejects failed verification without materializing state', async () => {
    const stateKey = `payment.${randomUUID()}`;
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      ingestInboundEvent(tx, inboundEnvelope({
        dedupe_key: `dedupe-c-${randomUUID()}`,
        signaturePresent: true,
        signatureValid: false,
      }), {
        materialization: {
          state_key: stateKey,
          domain: 'payments',
          subject_ref: 'payment-subject-c',
          value: { status: 'received' },
        },
      })
    );

    assert.equal(result.accepted, false);
    assert.equal(result.materialized, false);

    const stateCount = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT count(*)::int n FROM current_state_records WHERE state_key = $1;',
        [stateKey]
      )).rows[0].n
    );
    assert.equal(stateCount, 0);
  });
});

describe('D) unknown source is rejected', () => {
  test('gate rejects auth-required event from unknown connector', async () => {
    const resolution = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      resolveInboundSource(tx, {
        source_connection_id: 'conn.does-not-exist',
        provider: 'fixture-provider',
      })
    );
    assert.equal(resolution.found, false);
    assert.equal(resolution.reason, 'unknown_source');

    const gate = runInboundAuthenticityGate({
      event_type: 'provider.payment.received',
      source_system: 'fixture-provider',
      provider: 'fixture-provider',
      source_connection_id: 'conn.does-not-exist',
      signaturePresent: true,
      signatureValid: true,
      connectorResolution: resolution,
    });

    assert.equal(gate.accepted, false);
    assert.equal(gate.verification_result, 'REJECTED');
    assert.equal(gate.rejection_reason, 'unknown_source');
    assert.equal(gate.evidence.rejection_reason, 'unknown_source');
  });

  test('ingest rejects unknown source without materializing state', async () => {
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      ingestInboundEvent(tx, inboundEnvelope({
        dedupe_key: `dedupe-d-${randomUUID()}`,
        source_connection_id: 'conn.unknown',
      }), {
        materialization: {
          state_key: `payment.${randomUUID()}`,
          domain: 'payments',
          subject_ref: 'payment-subject-d',
          value: { status: 'received' },
        },
      })
    );

    assert.equal(result.accepted, false);
    assert.equal(result.gate.rejection_reason, 'unknown_source');
    assert.equal(result.materialized, false);
  });
});

describe('E) rejected events never reach canonical materialization', () => {
  test('FAILED/UNKNOWN/unknown-source events persist with materialized_state=false only', async () => {
    const cases = [
      {
        label: 'unsigned',
        envelope: { signaturePresent: false, signatureValid: false },
      },
      {
        label: 'failed',
        envelope: { signaturePresent: true, signatureValid: false },
      },
      {
        label: 'unknown-source',
        envelope: { source_connection_id: 'conn.missing' },
      },
    ];

    for (const c of cases) {
      const dedupe = `dedupe-e-${c.label}-${randomUUID()}`;
      const stateKey = `payment.${c.label}.${randomUUID()}`;
      const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
        ingestInboundEvent(tx, inboundEnvelope({ dedupe_key: dedupe, ...c.envelope }), {
          materialization: {
            state_key: stateKey,
            domain: 'payments',
            subject_ref: `subject-${c.label}`,
            value: { status: 'received' },
          },
        })
      );

      assert.equal(result.accepted, false, c.label);
      assert.equal(result.materialized, false, c.label);

      const linked = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
        (await tx.query(
          `SELECT count(*)::int n
             FROM current_state_records
            WHERE last_event_id = $1 OR state_key = $2;`,
          [result.event_id, stateKey]
        )).rows[0].n
      );
      assert.equal(linked, 0, `${c.label}: rejected event must not materialize canonical state`);
    }
  });
});

describe('F) existing valid behavior remains passing', () => {
  test('canMaterializeCanonicalState boundary unchanged', () => {
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
  });

  test('fakeProviderAdapter boundary unchanged', () => {
    assert.equal(
      fakeProviderAdapter({ signaturePresent: true, signatureValid: true }).authenticity_status,
      'VERIFIED'
    );
    assert.equal(
      fakeProviderAdapter({ signaturePresent: true, signatureValid: false }).authenticity_status,
      'FAILED'
    );
    assert.equal(
      fakeProviderAdapter({ signaturePresent: false, signatureValid: false }).authenticity_status,
      'UNKNOWN'
    );
  });

  test('non-auth-required events bypass connector requirement', async () => {
    const result = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      ingestInboundEvent(tx, {
        event_type: 'internal.tick',
        source_system: 'agencyos',
        provider: 'agencyos',
        dedupe_key: `dedupe-f-${randomUUID()}`,
        signaturePresent: false,
        signatureValid: false,
      }, {
        materialization: {
          state_key: `tick.${randomUUID()}`,
          domain: 'system',
          subject_ref: 'tick-subject',
          value: { tick: 1 },
        },
      })
    );

    assert.equal(result.accepted, true);
    assert.equal(result.materialized, true);
  });

  test('duplicate dedupe_key is idempotent and does not double-materialize', async () => {
    const dedupe = `dedupe-idempotent-${randomUUID()}`;
    const stateKey = `payment.idempotent.${randomUUID()}`;
    const envelope = inboundEnvelope({ dedupe_key: dedupe });
    const materialization = {
      state_key: stateKey,
      domain: 'payments',
      subject_ref: 'payment-idempotent',
      value: { status: 'received' },
    };

    const first = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      ingestInboundEvent(tx, envelope, { materialization })
    );
    const second = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      ingestInboundEvent(tx, envelope, { materialization })
    );

    assert.equal(first.accepted, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.event_id, first.event_id);

    const count = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT count(*)::int n FROM canonical_events WHERE dedupe_key = $1;',
        [dedupe]
      )).rows[0].n
    );
    assert.equal(count, 1);
  });
});
