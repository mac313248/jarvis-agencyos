// src/runtime/inbound-authenticity-gate.js
// Explicit fail-closed inbound-event authenticity gate before canonical
// event materialization (07_AUTHORITY_SECURITY_EXECUTION.md#Inbound-authenticity).
//
// Flow: resolve source → verify authenticity → gate decision → persist evidence
//       → materialize ONLY when gate accepts.
//
// NON-SCOPE: live provider webhooks, business writes. Autonomy remains DISABLED.
// Uses the deterministic fakeProviderAdapter boundary from contracts/events.js.

import { randomUUID } from 'node:crypto';
import {
  AUTH_REQUIRED_EVENT_TYPES,
  canMaterializeCanonicalState,
  fakeProviderAdapter,
} from '../contracts/events.js';
import { assertBusinessWriteAutonomyDisabled } from './autonomy.js';

export const INBOUND_AUTHENTICITY_GATE_CONTRACT_VERSION = 1;

export class InboundAuthenticityGateError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'InboundAuthenticityGateError';
    this.code = code;
    this.details = details;
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InboundAuthenticityGateError('INVALID_ENVELOPE', `${field} required`);
  }
  return value;
}

export function buildGateEvidence({
  source_system,
  provider,
  source_connection_id = null,
  verification_result,
  rejection_reason = null,
  authenticity_status,
  authenticity_method,
}) {
  return Object.freeze({
    contract_version: INBOUND_AUTHENTICITY_GATE_CONTRACT_VERSION,
    source_system,
    provider,
    source_connection_id,
    verification_result,
    rejection_reason,
    authenticity_status,
    authenticity_method,
  });
}

/**
 * Resolve inbound source against the tenant connector registry.
 * Fail closed: unknown/disabled/mismatched sources are not trusted.
 */
export async function resolveInboundSource(backend, {
  source_connection_id = null,
  provider = null,
} = {}) {
  if (!source_connection_id) {
    return Object.freeze({
      found: false,
      connector: null,
      reason: 'missing_source_connection_id',
    });
  }

  const r = await backend.query(
    `SELECT connector_id, provider, status, authenticity_verification_ref
       FROM connectors
      WHERE connector_id = $1;`,
    [source_connection_id]
  );
  const row = r.rows[0];
  if (!row) {
    return Object.freeze({
      found: false,
      connector: null,
      reason: 'unknown_source',
    });
  }
  if (row.status === 'disabled') {
    return Object.freeze({
      found: false,
      connector: row,
      reason: 'source_disabled',
    });
  }
  if (provider && row.provider !== provider) {
    return Object.freeze({
      found: false,
      connector: row,
      reason: 'provider_mismatch',
    });
  }
  return Object.freeze({
    found: true,
    connector: row,
    reason: null,
  });
}

/**
 * THE EXPLICIT INBOUND AUTHENTICITY GATE.
 * Single deterministic gate evaluated before canonical materialization.
 * Never guesses, silently trusts, or weakens verification.
 */
export function runInboundAuthenticityGate({
  event_type,
  source_system,
  provider,
  source_connection_id = null,
  signaturePresent = false,
  signatureValid = false,
  connectorResolution = null,
} = {}) {
  requireString(event_type, 'event_type');
  requireString(source_system, 'source_system');
  requireString(provider, 'provider');

  const authRequired = AUTH_REQUIRED_EVENT_TYPES.has(event_type);

  if (authRequired) {
    if (!connectorResolution?.found) {
      const reason = connectorResolution?.reason || 'unknown_source';
      return Object.freeze({
        accepted: false,
        authenticity_status: 'UNKNOWN',
        authenticity_method: 'gate:unknown-source',
        verification_result: 'REJECTED',
        rejection_reason: reason,
        may_materialize: false,
        evidence: buildGateEvidence({
          source_system,
          provider,
          source_connection_id,
          verification_result: 'REJECTED',
          rejection_reason: reason,
          authenticity_status: 'UNKNOWN',
          authenticity_method: 'gate:unknown-source',
        }),
      });
    }

    if (!connectorResolution.connector.authenticity_verification_ref) {
      const reason = 'missing_authenticity_verification_ref';
      return Object.freeze({
        accepted: false,
        authenticity_status: 'UNKNOWN',
        authenticity_method: 'gate:no-verification-ref',
        verification_result: 'REJECTED',
        rejection_reason: reason,
        may_materialize: false,
        evidence: buildGateEvidence({
          source_system,
          provider,
          source_connection_id,
          verification_result: 'REJECTED',
          rejection_reason: reason,
          authenticity_status: 'UNKNOWN',
          authenticity_method: 'gate:no-verification-ref',
        }),
      });
    }
  }

  const adapterResult = authRequired
    ? fakeProviderAdapter({ signaturePresent: !!signaturePresent, signatureValid: !!signatureValid })
    : {
        authenticity_status: 'NOT_APPLICABLE',
        authenticity_method: 'gate:not-required',
      };

  const materializeDecision = canMaterializeCanonicalState({
    event_type,
    authenticity_status: adapterResult.authenticity_status,
    content_trust: 'UNTRUSTED_PAYLOAD',
  });

  const accepted = materializeDecision.mayMaterialize;
  let rejection_reason = null;
  if (!accepted) {
    if (adapterResult.authenticity_status === 'FAILED') {
      rejection_reason = 'authenticity_failed';
    } else if (adapterResult.authenticity_status === 'UNKNOWN') {
      rejection_reason = 'authenticity_unknown';
    } else {
      rejection_reason = materializeDecision.reason;
    }
  }

  const verification_result = accepted ? 'ACCEPTED' : 'REJECTED';

  return Object.freeze({
    accepted,
    authenticity_status: adapterResult.authenticity_status,
    authenticity_method: adapterResult.authenticity_method,
    verification_result,
    rejection_reason,
    may_materialize: materializeDecision.mayMaterialize,
    evidence: buildGateEvidence({
      source_system,
      provider,
      source_connection_id,
      verification_result,
      rejection_reason,
      authenticity_status: adapterResult.authenticity_status,
      authenticity_method: adapterResult.authenticity_method,
    }),
  });
}

async function findExistingByDedupe(backend, dedupe_key) {
  const r = await backend.query(
    `SELECT event_id, authenticity_status, materialized_state
       FROM canonical_events
      WHERE dedupe_key = $1;`,
    [dedupe_key]
  );
  return r.rows[0] ?? null;
}

/**
 * Ingest one inbound event through the authenticity gate and optionally
 * materialize canonical state when — and only when — the gate accepts.
 */
export async function ingestInboundEvent(backend, envelope, {
  materialization = null,
} = {}) {
  assertBusinessWriteAutonomyDisabled();

  const event_type = requireString(envelope.event_type, 'event_type');
  const source_system = requireString(envelope.source_system, 'source_system');
  const provider = requireString(envelope.provider, 'provider');
  const dedupe_key = requireString(envelope.dedupe_key, 'dedupe_key');
  const source_connection_id = envelope.source_connection_id ?? null;
  const signaturePresent = envelope.signaturePresent === true;
  const signatureValid = envelope.signatureValid === true;
  const typed_properties = envelope.typed_properties ?? {};
  const subject_refs = envelope.subject_refs ?? [];
  const content_trust = envelope.content_trust ?? 'UNTRUSTED_PAYLOAD';

  const existing = await findExistingByDedupe(backend, dedupe_key);
  if (existing) {
    return Object.freeze({
      duplicate: true,
      event_id: existing.event_id,
      accepted: existing.materialized_state,
      materialized: existing.materialized_state,
      gate: null,
    });
  }

  const connectorResolution = await resolveInboundSource(backend, {
    source_connection_id,
    provider,
  });

  const gate = runInboundAuthenticityGate({
    event_type,
    source_system,
    provider,
    source_connection_id,
    signaturePresent,
    signatureValid,
    connectorResolution,
  });

  const event_id = envelope.event_id || randomUUID();
  const gateEvidence = {
    ...gate.evidence,
    gate_contract_version: INBOUND_AUTHENTICITY_GATE_CONTRACT_VERSION,
  };
  const persistedProperties = {
    ...typed_properties,
    inbound_authenticity_gate: gateEvidence,
  };

  const materialized_state = gate.accepted === true;

  // canonical_events.source_connection_id is uuid|null per 06; connector registry
  // uses opaque text connector_id. Persist the text connector ref in gate evidence
  // only — do not coerce or guess a uuid binding.
  await backend.query(
    `INSERT INTO canonical_events (
       event_id, tenant_id, event_type, source_system,
       source_event_id, occurred_at, subject_refs, typed_properties, dedupe_key,
       authenticity_status, authenticity_method, content_trust, materialized_state
     ) VALUES (
       $1, cur_tenant(), $2, $3,
       $4, $5, $6::jsonb, $7::jsonb, $8,
       $9, $10, $11, $12
     );`,
    [
      event_id,
      event_type,
      source_system,
      envelope.source_event_id ?? null,
      envelope.occurred_at ?? null,
      JSON.stringify(subject_refs),
      JSON.stringify(persistedProperties),
      dedupe_key,
      gate.authenticity_status,
      gate.authenticity_method,
      content_trust,
      materialized_state,
    ]
  );

  let state_id = null;
  if (gate.accepted && materialization) {
    const stateKey = requireString(materialization.state_key, 'materialization.state_key');
    const domain = requireString(materialization.domain, 'materialization.domain');
    const subject_ref = requireString(materialization.subject_ref, 'materialization.subject_ref');
    const value = materialization.value ?? {};
    state_id = materialization.state_id || randomUUID();

    await backend.query(
      `INSERT INTO current_state_records (
         state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
         source_system, as_of, observed_at, verified_at, max_age_seconds,
         freshness, conflict_status, last_event_id, evidence_refs
       ) VALUES (
         $1, cur_tenant(), $2, $3, $4, $5::jsonb, $6,
         $7, COALESCE($8::timestamptz, now()), now(), now(), $9,
         'FRESH', 'NONE', $10, '[]'::jsonb
       )
       ON CONFLICT (tenant_id, state_key) DO UPDATE SET
         value = EXCLUDED.value,
         state_version = EXCLUDED.state_version,
         source_system = EXCLUDED.source_system,
         as_of = EXCLUDED.as_of,
         observed_at = EXCLUDED.observed_at,
         verified_at = EXCLUDED.verified_at,
         freshness = EXCLUDED.freshness,
         last_event_id = EXCLUDED.last_event_id;`,
      [
        state_id,
        stateKey,
        domain,
        subject_ref,
        JSON.stringify(value),
        materialization.state_version ?? '1',
        source_system,
        envelope.occurred_at ?? null,
        materialization.max_age_seconds ?? 3600,
        event_id,
      ]
    );
  }

  return Object.freeze({
    duplicate: false,
    event_id,
    accepted: gate.accepted,
    materialized: materialized_state,
    state_id,
    gate,
  });
}
