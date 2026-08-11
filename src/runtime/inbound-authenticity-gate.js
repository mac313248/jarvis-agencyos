// src/runtime/inbound-authenticity-gate.js
// Fail-closed inbound-event authenticity gate (Stage-1 secure core).
//
// Per 07_AUTHORITY_SECURITY_EXECUTION.md#Inbound-authenticity and
// 06_SYSTEM_CONTRACTS.md#CanonicalEvent:
//   ONE explicit gate runs before canonical event materialization.
//   FAILED / missing / unknown authenticity must NOT become canonical state.
//   Verified trusted events may continue to existing materialization.
//
// NON-SCOPE: provider-specific live integrations; business-write autonomy.

import { randomUUID } from 'node:crypto';
import {
  AUTH_REQUIRED_EVENT_TYPES,
  canMaterializeCanonicalState,
  fakeProviderAdapter,
  isAuthenticitySatisfied,
} from '../contracts/events.js';
import { loadConnector, ConnectorValidationError } from '../contracts/connector.js';
import { assertBusinessWriteAutonomyDisabled } from './autonomy.js';
import { buildCurrentStateRecord } from './reconciliation.js';

export const INBOUND_AUTHENTICITY_GATE_VERSION = 1;

export class InboundAuthenticityGateError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'InboundAuthenticityGateError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Deterministic signature verification for registered connector refs.
 * Fail closed: no guessing, no silent trust, no weakened verification.
 */
export function verifyInboundSignature({ connector, verification = {} } = {}) {
  const ref = connector?.authenticity_verification_ref ?? null;
  if (!ref) {
    return {
      authenticity_status: 'UNKNOWN',
      authenticity_method: null,
      verification_result: 'UNKNOWN',
      rejection_reason: 'missing authenticity_verification_ref on connector',
    };
  }

  // Phase-1 deterministic fake adapter boundary (already required by acceptance #15).
  if (ref.startsWith('authver://fake/') || ref === 'authver://hmac/fake-adapter') {
    const result = fakeProviderAdapter(verification);
    return {
      ...result,
      verification_result: result.authenticity_status,
      rejection_reason: isAuthenticitySatisfied(result.authenticity_status)
        ? null
        : `signature verification ${result.authenticity_status.toLowerCase()}`,
    };
  }

  // Registered fixture/HMAC refs require explicit verification input — never assume trust.
  if (ref.startsWith('authver://hmac/')) {
    if (verification.signaturePresent === undefined && verification.signatureValid === undefined) {
      return {
        authenticity_status: 'UNKNOWN',
        authenticity_method: ref,
        verification_result: 'UNKNOWN',
        rejection_reason: 'missing signature verification input',
      };
    }
    const result = fakeProviderAdapter(verification);
    return {
      ...result,
      verification_result: result.authenticity_status,
      rejection_reason: isAuthenticitySatisfied(result.authenticity_status)
        ? null
        : `signature verification ${result.authenticity_status.toLowerCase()}`,
    };
  }

  return {
    authenticity_status: 'UNKNOWN',
    authenticity_method: ref,
    verification_result: 'UNKNOWN',
    rejection_reason: `unknown authenticity verification ref: ${ref}`,
  };
}

function buildGateEvidence({
  source_system,
  provider,
  connector_id = null,
  verification_result,
  rejection_reason = null,
  authenticity_method = null,
}) {
  return Object.freeze({
    gate_version: INBOUND_AUTHENTICITY_GATE_VERSION,
    source_system,
    provider: provider ?? source_system,
    connector_id,
    verification_result,
    authenticity_method,
    rejection_reason,
  });
}

/**
 * The explicit inbound authenticity gate — MUST run before materialization.
 * Returns { accepted, may_materialize, evidence, authenticity_status, content_trust, rejection_reason }.
 */
export async function evaluateInboundAuthenticityGate(backend, inbound) {
  assertBusinessWriteAutonomyDisabled();

  const event_type = inbound.event_type;
  const source_system = inbound.source_system;
  const content_trust = inbound.content_trust ?? 'UNTRUSTED_PAYLOAD';

  if (!event_type || !source_system) {
    throw new InboundAuthenticityGateError(
      'INVALID_INBOUND',
      'event_type and source_system are required'
    );
  }

  const authRequired = AUTH_REQUIRED_EVENT_TYPES.has(event_type);

  // Events that do not require provider auth pass through with NOT_APPLICABLE.
  if (!authRequired) {
    const evidence = buildGateEvidence({
      source_system,
      provider: source_system,
      verification_result: 'NOT_APPLICABLE',
      rejection_reason: null,
      authenticity_method: null,
    });
    return Object.freeze({
      accepted: true,
      may_materialize: true,
      authenticity_status: 'NOT_APPLICABLE',
      content_trust,
      rejection_reason: null,
      evidence,
    });
  }

  // Auth-required: resolve connector for trusted source (fail closed on unknown source).
  let connector = inbound.connector ?? null;
  const connector_id = inbound.connector_id ?? null;

  if (!connector && connector_id && backend) {
    try {
      connector = await loadConnector(backend, connector_id);
    } catch (e) {
      if (e instanceof ConnectorValidationError && /unknown connector/.test(e.message)) {
        const evidence = buildGateEvidence({
          source_system,
          provider: source_system,
          connector_id,
          verification_result: 'UNKNOWN',
          rejection_reason: `unknown source connector: ${connector_id}`,
        });
        return Object.freeze({
          accepted: false,
          may_materialize: false,
          authenticity_status: 'UNKNOWN',
          content_trust,
          rejection_reason: evidence.rejection_reason,
          evidence,
        });
      }
      throw e;
    }
  }

  if (!connector) {
    const evidence = buildGateEvidence({
      source_system,
      provider: source_system,
      connector_id,
      verification_result: 'UNKNOWN',
      rejection_reason: 'unknown or unregistered inbound source',
    });
    return Object.freeze({
      accepted: false,
      may_materialize: false,
      authenticity_status: 'UNKNOWN',
      content_trust,
      rejection_reason: evidence.rejection_reason,
      evidence,
    });
  }

  if (connector.status !== 'active') {
    const evidence = buildGateEvidence({
      source_system,
      provider: connector.provider,
      connector_id: connector.connector_id,
      verification_result: 'UNKNOWN',
      rejection_reason: `source connector status=${connector.status}`,
    });
    return Object.freeze({
      accepted: false,
      may_materialize: false,
      authenticity_status: 'UNKNOWN',
      content_trust,
      rejection_reason: evidence.rejection_reason,
      evidence,
    });
  }

  if (connector.provider && connector.provider !== source_system) {
    const evidence = buildGateEvidence({
      source_system,
      provider: connector.provider,
      connector_id: connector.connector_id,
      verification_result: 'UNKNOWN',
      rejection_reason: `source_system mismatch: expected ${connector.provider}`,
    });
    return Object.freeze({
      accepted: false,
      may_materialize: false,
      authenticity_status: 'UNKNOWN',
      content_trust,
      rejection_reason: evidence.rejection_reason,
      evidence,
    });
  }

  const verified = verifyInboundSignature({
    connector,
    verification: inbound.verification ?? {},
  });
  const materializeDecision = canMaterializeCanonicalState({
    event_type,
    authenticity_status: verified.authenticity_status,
    content_trust,
  });

  const evidence = buildGateEvidence({
    source_system,
    provider: connector.provider,
    connector_id: connector.connector_id,
    verification_result: verified.verification_result ?? verified.authenticity_status,
    rejection_reason: materializeDecision.mayMaterialize ? null : (verified.rejection_reason ?? materializeDecision.reason),
    authenticity_method: verified.authenticity_method ?? null,
  });

  return Object.freeze({
    accepted: materializeDecision.mayMaterialize,
    may_materialize: materializeDecision.mayMaterialize,
    authenticity_status: verified.authenticity_status,
    content_trust,
    rejection_reason: evidence.rejection_reason,
    evidence,
  });
}

async function requireTenant(backend) {
  const r = await backend.query('SELECT cur_tenant() AS t;');
  const t = r.rows[0]?.t;
  if (!t) {
    throw new InboundAuthenticityGateError('MISSING_TENANT_CONTEXT', 'missing tenant context (fail-closed)');
  }
  return t;
}

/**
 * Persist canonical event + optional current_state materialization.
 * Gate evaluation ALWAYS precedes INSERT; rejected events never materialize state.
 */
export async function processInboundEvent(backend, inbound, { now = new Date().toISOString() } = {}) {
  assertBusinessWriteAutonomyDisabled();
  await requireTenant(backend);

  const gate = await evaluateInboundAuthenticityGate(backend, inbound);
  const eventId = inbound.event_id ?? randomUUID();
  const dedupeKey = inbound.dedupe_key ?? `inbound-${eventId}`;

  const typedProperties = {
    ...(inbound.typed_properties ?? {}),
    _inbound_authenticity_gate: gate.evidence,
  };

  await backend.query(
    `INSERT INTO canonical_events (
       event_id, tenant_id, event_type, source_system, source_connection_id,
       source_event_id, occurred_at, received_at, subject_refs, typed_properties,
       dedupe_key, authenticity_status, authenticity_method, content_trust,
       materialized_state
     ) VALUES (
       $1, cur_tenant(), $2, $3, $4,
       $5, $6::timestamptz, $7::timestamptz, $8::jsonb, $9::jsonb,
       $10, $11, $12, $13, $14
     );`,
    [
      eventId,
      inbound.event_type,
      inbound.source_system,
      inbound.source_connection_id ?? null,
      inbound.source_event_id ?? null,
      inbound.occurred_at ?? null,
      inbound.received_at ?? now,
      JSON.stringify(inbound.subject_refs ?? []),
      JSON.stringify(typedProperties),
      dedupeKey,
      gate.authenticity_status,
      gate.evidence.authenticity_method,
      gate.content_trust,
      gate.may_materialize,
    ]
  );

  let stateRecord = null;
  if (gate.may_materialize && inbound.materialization) {
    const m = inbound.materialization;
    stateRecord = buildCurrentStateRecord({
      tenant_id: (await requireTenant(backend)),
      state_key: m.state_key,
      domain: m.domain,
      subject_ref: m.subject_ref,
      value: m.value ?? {},
      state_version: m.state_version ?? '1',
      source_system: inbound.source_system,
      as_of: m.as_of ?? now,
      observed_at: m.observed_at ?? now,
      max_age_seconds: m.max_age_seconds ?? 3600,
      last_event_id: eventId,
      evidence_refs: m.evidence_refs ?? [],
    });

    await backend.query(
      `INSERT INTO current_state_records (
         state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
         source_system, as_of, observed_at, verified_at, max_age_seconds,
         freshness, conflict_status, last_event_id, evidence_refs
       ) VALUES (
         $1, cur_tenant(), $2, $3, $4, $5::jsonb, $6,
         $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11,
         $12, $13, $14, $15::jsonb
       )
       ON CONFLICT (tenant_id, state_key) DO UPDATE SET
         value = EXCLUDED.value,
         state_version = EXCLUDED.state_version,
         source_system = EXCLUDED.source_system,
         as_of = EXCLUDED.as_of,
         observed_at = EXCLUDED.observed_at,
         verified_at = EXCLUDED.verified_at,
         max_age_seconds = EXCLUDED.max_age_seconds,
         freshness = EXCLUDED.freshness,
         conflict_status = EXCLUDED.conflict_status,
         last_event_id = EXCLUDED.last_event_id,
         evidence_refs = EXCLUDED.evidence_refs;`,
      [
        randomUUID(),
        stateRecord.state_key,
        stateRecord.domain,
        stateRecord.subject_ref,
        JSON.stringify(stateRecord.value),
        stateRecord.state_version,
        stateRecord.source_system,
        stateRecord.as_of,
        stateRecord.observed_at,
        stateRecord.verified_at,
        stateRecord.max_age_seconds,
        stateRecord.freshness,
        stateRecord.conflict_status,
        stateRecord.last_event_id,
        JSON.stringify(stateRecord.evidence_refs),
      ]
    );
  }

  return Object.freeze({
    event_id: eventId,
    gate,
    materialized: gate.may_materialize,
    state_record: stateRecord,
  });
}
