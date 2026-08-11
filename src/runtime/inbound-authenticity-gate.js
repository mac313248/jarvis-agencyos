// src/runtime/inbound-authenticity-gate.js
// Fail-closed inbound-event authenticity gate (Stage-1 secure core).
//
// Per 07_AUTHORITY_SECURITY_EXECUTION.md#Inbound-authenticity and
// 06_SYSTEM_CONTRACTS.md#CanonicalEvent:
//   ONE explicit gate runs before canonical event materialization.
//   FAILED / missing / unknown authenticity must NOT become canonical state.
//   Verified trusted external events may continue to existing materialization.
//
// Owner classification lock:
//   EXTERNAL/UNKNOWN → trusted connector registry lookup → authenticity
//     verification → PASS may continue; missing/failed/unknown = REJECT.
//   TRUSTED INTERNAL → positive classification from trusted infrastructure
//     provenance only → may bypass external connector authentication.
//   NO caller-supplied field may classify an event as trusted/internal.
//   NO NOT_APPLICABLE passthrough for unknown/external events.
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

/** Trusted infrastructure provenance source identifier (not caller-supplied). */
export const TRUSTED_INTERNAL_PROVENANCE_SOURCE = 'agencyos.trusted-runtime';

/** Event types that trusted internal provenance may authorize (registry only). */
export const TRUSTED_INTERNAL_EVENT_TYPES = Object.freeze([
  'internal.tick',
]);

/** Deterministic test signature value accepted by the fake verification boundary. */
export const TRUSTED_FAKE_SIGNATURE_HEADER = 'valid-test-sig';

export class InboundAuthenticityGateError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'InboundAuthenticityGateError';
    this.code = code;
    this.details = details;
  }
}

const UNTRUSTED_VERIFICATION_CLAIM_KEYS = Object.freeze([
  'signaturePresent',
  'signatureValid',
  'authenticity_status',
  'verification_result',
]);

const UNTRUSTED_CLASSIFICATION_KEYS = Object.freeze([
  'trusted_internal',
  'is_internal',
  'is_trusted',
  'internal',
  'provenance',
  'classification',
  'trusted_provenance',
  'internal_provenance',
  'source_classification',
  'event_classification',
  'trusted',
]);

function hasUntrustedVerificationClaims(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return UNTRUSTED_VERIFICATION_CLAIM_KEYS.some((k) =>
    Object.prototype.hasOwnProperty.call(value, k)
  );
}

function hasUntrustedClassificationClaims(inbound) {
  if (!inbound || typeof inbound !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(inbound, 'connector')
    && inbound.connector !== null
    && typeof inbound.connector === 'object') {
    return true;
  }
  return UNTRUSTED_CLASSIFICATION_KEYS.some((k) =>
    Object.prototype.hasOwnProperty.call(inbound, k)
  );
}

/**
 * Trusted-internal classification is NOT a caller-mintable object.
 * The sealed entrypoint `processTrustedInternalEvent` is the infrastructure
 * provenance boundary. Plain objects, payload fields, and options such as
 * trusted_provenance cannot authorize an authenticity bypass.
 */

/**
 * Derive deterministic fake-adapter inputs from raw envelope material only.
 * Never accepts pre-computed verification status from callers.
 */
function deriveFakeAdapterInputsFromRawEnvelope(verification_input = {}) {
  const header = verification_input.signature_header;
  const signaturePresent = header != null && String(header).length > 0;
  const signatureValid = signaturePresent && String(header) === TRUSTED_FAKE_SIGNATURE_HEADER;
  return { signaturePresent, signatureValid };
}

/**
 * Trusted verification boundary — the ONLY producer of inbound authenticity status.
 * Accepts registry-backed connector metadata plus raw verification_input envelope
 * material. Rejects caller-asserted verification claims (fail closed).
 */
export function verifyInboundSignature({ connector, verification_input = {} } = {}) {
  if (hasUntrustedVerificationClaims(verification_input)) {
    return {
      authenticity_status: 'UNKNOWN',
      authenticity_method: null,
      verification_result: 'UNKNOWN',
      rejection_reason: 'untrusted verification claims rejected; authenticity requires trusted boundary',
    };
  }

  const ref = connector?.authenticity_verification_ref ?? null;
  if (!ref) {
    return {
      authenticity_status: 'UNKNOWN',
      authenticity_method: null,
      verification_result: 'UNKNOWN',
      rejection_reason: 'missing authenticity_verification_ref on connector',
    };
  }

  // Phase-1 deterministic fake adapter boundary (acceptance #15).
  if (ref.startsWith('authver://fake/') || ref === 'authver://hmac/fake-adapter') {
    const derived = deriveFakeAdapterInputsFromRawEnvelope(verification_input);
    const result = fakeProviderAdapter(derived);
    return {
      ...result,
      verification_result: result.authenticity_status,
      rejection_reason: isAuthenticitySatisfied(result.authenticity_status)
        ? null
        : `signature verification ${result.authenticity_status.toLowerCase()}`,
    };
  }

  // Real HMAC refs are not implemented in Phase-1 — fail closed (no fake-HMAC passthrough).
  if (ref.startsWith('authver://hmac/')) {
    return {
      authenticity_status: 'UNKNOWN',
      authenticity_method: ref,
      verification_result: 'UNKNOWN',
      rejection_reason: 'HMAC authenticity verification not available in Phase-1 boundary',
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
  classification = null,
  provenance_source = null,
  provenance_boundary = null,
}) {
  return Object.freeze({
    gate_version: INBOUND_AUTHENTICITY_GATE_VERSION,
    source_system,
    provider: provider ?? source_system,
    connector_id,
    verification_result,
    authenticity_method,
    rejection_reason,
    classification,
    provenance_source,
    provenance_boundary,
  });
}

function rejectGate({
  source_system,
  provider,
  connector_id = null,
  content_trust,
  authenticity_status,
  verification_result,
  rejection_reason,
  authenticity_method = null,
  classification = null,
}) {
  const evidence = buildGateEvidence({
    source_system,
    provider,
    connector_id,
    verification_result,
    rejection_reason,
    authenticity_method,
    classification,
  });
  return Object.freeze({
    accepted: false,
    may_materialize: false,
    authenticity_status,
    content_trust,
    rejection_reason,
    evidence,
  });
}

/**
 * Load connector exclusively from the trusted tenant registry (never caller objects).
 */
async function loadTrustedRegistryConnector(backend, connector_id) {
  if (typeof connector_id !== 'string' || connector_id.length === 0) {
    return {
      connector: null,
      rejection_reason: 'unknown or unregistered inbound source',
    };
  }
  try {
    const connector = await loadConnector(backend, connector_id);
    return { connector, rejection_reason: null };
  } catch (e) {
    if (e instanceof ConnectorValidationError && /unknown connector/.test(e.message)) {
      return {
        connector: null,
        rejection_reason: `unknown source connector: ${connector_id}`,
      };
    }
    throw e;
  }
}

/**
 * The explicit inbound authenticity gate for untrusted/external inbound paths.
 * MUST run before materialization. Never accepts caller-supplied trusted/internal
 * classification or verification claims. Trusted-internal events must use the
 * sealed `processTrustedInternalEvent` entrypoint instead.
 *
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

  // Caller-asserted classification/trusted labels on the untrusted payload are never accepted.
  if (hasUntrustedClassificationClaims(inbound)) {
    return rejectGate({
      source_system,
      provider: source_system,
      connector_id: inbound.connector_id ?? null,
      content_trust,
      authenticity_status: 'UNKNOWN',
      verification_result: 'UNKNOWN',
      rejection_reason: 'caller-supplied trusted/internal classification rejected',
    });
  }

  // Caller-asserted verification claims on the untrusted payload are never accepted.
  if (hasUntrustedVerificationClaims(inbound.verification)) {
    return rejectGate({
      source_system,
      provider: source_system,
      connector_id: inbound.connector_id ?? null,
      content_trust,
      authenticity_status: 'UNKNOWN',
      verification_result: 'UNKNOWN',
      rejection_reason: 'untrusted inbound.verification claims rejected',
    });
  }

  const authRequired = AUTH_REQUIRED_EVENT_TYPES.has(event_type);

  // External/unknown (and any non-auth-required type on this path) fail closed.
  // Trusted-internal bypass is only available via processTrustedInternalEvent.
  if (!authRequired) {
    return rejectGate({
      source_system,
      provider: source_system,
      connector_id: inbound.connector_id ?? null,
      content_trust,
      authenticity_status: 'UNKNOWN',
      verification_result: 'UNKNOWN',
      rejection_reason:
        'external/unknown event requires connector authenticity; trusted-internal must use sealed infrastructure entrypoint',
      classification: 'EXTERNAL_OR_UNKNOWN',
    });
  }

  // Auth-required external events: resolve connector ONLY from trusted registry.
  const connector_id = inbound.connector_id ?? null;
  const { connector, rejection_reason: loadReason } = await loadTrustedRegistryConnector(
    backend,
    connector_id
  );

  if (!connector) {
    return rejectGate({
      source_system,
      provider: source_system,
      connector_id,
      content_trust,
      authenticity_status: 'UNKNOWN',
      verification_result: 'UNKNOWN',
      rejection_reason: loadReason ?? 'unknown or unregistered inbound source',
      classification: 'EXTERNAL_OR_UNKNOWN',
    });
  }

  if (connector.status !== 'active') {
    return rejectGate({
      source_system,
      provider: connector.provider,
      connector_id: connector.connector_id,
      content_trust,
      authenticity_status: 'UNKNOWN',
      verification_result: 'UNKNOWN',
      rejection_reason: `source connector status=${connector.status}`,
      classification: 'EXTERNAL_OR_UNKNOWN',
    });
  }

  if (connector.provider && connector.provider !== source_system) {
    return rejectGate({
      source_system,
      provider: connector.provider,
      connector_id: connector.connector_id,
      content_trust,
      authenticity_status: 'UNKNOWN',
      verification_result: 'UNKNOWN',
      rejection_reason: `source_system mismatch: expected ${connector.provider}`,
      classification: 'EXTERNAL_OR_UNKNOWN',
    });
  }

  const verified = verifyInboundSignature({
    connector,
    verification_input: inbound.verification_input ?? {},
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
    rejection_reason: materializeDecision.mayMaterialize
      ? null
      : (verified.rejection_reason ?? materializeDecision.reason),
    authenticity_method: verified.authenticity_method ?? null,
    classification: 'EXTERNAL_OR_UNKNOWN',
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

async function findExistingInboundEvent(backend, dedupeKey) {
  const r = await backend.query(
    `SELECT event_id, materialized_state, authenticity_status, content_trust,
            typed_properties->'_inbound_authenticity_gate' AS gate_evidence
     FROM canonical_events
     WHERE dedupe_key = $1;`,
    [dedupeKey]
  );
  return r.rows[0] ?? null;
}

function gateFromExistingRow(row) {
  const evidence = row.gate_evidence ?? {};
  const may_materialize = row.materialized_state === true;
  return Object.freeze({
    accepted: may_materialize,
    may_materialize,
    authenticity_status: row.authenticity_status,
    content_trust: row.content_trust,
    rejection_reason: evidence.rejection_reason ?? null,
    evidence,
  });
}

async function persistInboundResult(backend, inbound, gate, { now }) {
  const eventId = inbound.event_id ?? randomUUID();
  const dedupeKey = inbound.dedupe_key ?? `inbound-${eventId}`;

  const existing = await findExistingInboundEvent(backend, dedupeKey);
  if (existing) {
    return Object.freeze({
      event_id: existing.event_id,
      gate: gateFromExistingRow(existing),
      materialized: existing.materialized_state === true,
      state_record: null,
      replay: true,
    });
  }

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
    replay: false,
  });
}

/**
 * Persist canonical event + optional current_state materialization for untrusted
 * inbound events. Gate evaluation ALWAYS precedes INSERT; rejected events never
 * materialize state. Deterministic replay: duplicate dedupe_key returns existing
 * event without a second state transition.
 *
 * Does NOT accept trusted_provenance or any caller-supplied internal classification.
 */
export async function processInboundEvent(
  backend,
  inbound,
  { now = new Date().toISOString() } = {}
) {
  assertBusinessWriteAutonomyDisabled();
  await requireTenant(backend);
  const gate = await evaluateInboundAuthenticityGate(backend, inbound);
  return persistInboundResult(backend, inbound, gate, { now });
}

/**
 * Sealed trusted-infrastructure entrypoint for positively classified internal events.
 * Calling this API is the provenance boundary — not a forgeable options object.
 * Untrusted callers must use processInboundEvent (fail-closed external path).
 */
export async function processTrustedInternalEvent(
  backend,
  inbound,
  { now = new Date().toISOString() } = {}
) {
  assertBusinessWriteAutonomyDisabled();
  await requireTenant(backend);

  const event_type = inbound?.event_type;
  const source_system = inbound?.source_system;
  const content_trust = inbound?.content_trust ?? 'TRUSTED_STRUCTURED';

  if (!event_type || !source_system) {
    throw new InboundAuthenticityGateError(
      'INVALID_INBOUND',
      'event_type and source_system are required'
    );
  }

  if (hasUntrustedClassificationClaims(inbound) || hasUntrustedVerificationClaims(inbound?.verification)) {
    const gate = rejectGate({
      source_system,
      provider: source_system,
      connector_id: inbound.connector_id ?? null,
      content_trust,
      authenticity_status: 'UNKNOWN',
      verification_result: 'UNKNOWN',
      rejection_reason: 'caller-supplied trusted/internal classification rejected',
    });
    return persistInboundResult(backend, inbound, gate, { now });
  }

  if (!TRUSTED_INTERNAL_EVENT_TYPES.includes(event_type)) {
    const gate = rejectGate({
      source_system,
      provider: source_system,
      connector_id: inbound.connector_id ?? null,
      content_trust,
      authenticity_status: 'UNKNOWN',
      verification_result: 'UNKNOWN',
      rejection_reason: `event_type not in trusted internal registry: ${event_type}`,
      classification: 'EXTERNAL_OR_UNKNOWN',
    });
    return persistInboundResult(backend, inbound, gate, { now });
  }

  if (AUTH_REQUIRED_EVENT_TYPES.has(event_type)) {
    const gate = rejectGate({
      source_system,
      provider: source_system,
      connector_id: inbound.connector_id ?? null,
      content_trust,
      authenticity_status: 'UNKNOWN',
      verification_result: 'UNKNOWN',
      rejection_reason: 'auth-required event_type cannot use trusted-internal entrypoint',
      classification: 'EXTERNAL_OR_UNKNOWN',
    });
    return persistInboundResult(backend, inbound, gate, { now });
  }

  const gate = Object.freeze({
    accepted: true,
    may_materialize: true,
    authenticity_status: 'NOT_APPLICABLE',
    content_trust,
    rejection_reason: null,
    evidence: buildGateEvidence({
      source_system,
      provider: source_system,
      verification_result: 'NOT_APPLICABLE',
      rejection_reason: null,
      authenticity_method: null,
      classification: 'TRUSTED_INTERNAL',
      provenance_source: TRUSTED_INTERNAL_PROVENANCE_SOURCE,
      provenance_boundary: 'processTrustedInternalEvent',
    }),
  });

  return persistInboundResult(backend, inbound, gate, { now });
}
