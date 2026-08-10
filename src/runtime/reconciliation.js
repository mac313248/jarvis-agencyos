// src/runtime/reconciliation.js
// F-10 Materialized state / freshness / reconciliation.
//
// Per 06_SYSTEM_CONTRACTS.md#CurrentStateRecord and
// 07_AUTHORITY_SECURITY_EXECUTION.md#Reconciliation-safety:
//   - freshness ∈ FRESH|AGING|STALE|OFFLINE|CONFLICTED|UNKNOWN
//   - conflict_status ∈ NONE|PENDING_LOCAL_EFFECT|SOURCE_CONFLICT|UNKNOWN
//   - pending/ambiguous local effect MUST NOT be auto-overwritten as drift
//
// NON-SCOPE: business writes. Autonomy remains DISABLED.

import { randomUUID } from 'node:crypto';
import {
  assertBusinessWriteAutonomyDisabled,
  BUSINESS_WRITE_AUTONOMY,
} from './autonomy.js';

export const FRESHNESS_VALUES = Object.freeze([
  'FRESH',
  'AGING',
  'STALE',
  'OFFLINE',
  'CONFLICTED',
  'UNKNOWN',
]);

export const CONFLICT_STATUS_VALUES = Object.freeze([
  'NONE',
  'PENDING_LOCAL_EFFECT',
  'SOURCE_CONFLICT',
  'UNKNOWN',
]);

/** Effect ledger / receipt statuses that block provider drift overwrite. */
export const BLOCKING_EFFECT_STATUSES = Object.freeze([
  'PENDING',
  'COMMITTED',
]);

/** Postconditions that mean the local effect is still ambiguous. */
export const AMBIGUOUS_POSTCONDITIONS = Object.freeze([
  'AMBIGUOUS',
  'UNKNOWN',
  'UNVERIFIED',
]);

/** Age ratio of max_age_seconds at which FRESH becomes AGING. */
export const AGING_RATIO = 0.5;

export class ReconciliationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ReconciliationError';
    this.code = code;
    this.details = details;
  }
}

function toMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function stableValueHash(value) {
  // Deterministic shallow-stable JSON for mismatch detection (sorted keys).
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableValueHash).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableValueHash(value[k])).join(',') + '}';
}

/**
 * True when a local write is pending or its postcondition is ambiguous.
 * Such resources cannot be auto-overwritten from provider state as drift.
 */
export function isBlockingLocalEffect(localEffect) {
  if (!localEffect) return false;
  const status = localEffect.status ?? localEffect.effect_status ?? null;
  const post = localEffect.postcondition_status ?? localEffect.verification_status ?? null;
  const outcome = localEffect.outcome ?? null;

  if (status && BLOCKING_EFFECT_STATUSES.includes(status)) return true;
  if (post && AMBIGUOUS_POSTCONDITIONS.includes(post)) return true;
  if (outcome === 'AMBIGUOUS') return true;
  if (localEffect.ambiguous === true || localEffect.pending === true) return true;
  return false;
}

/**
 * Compute freshness label for a CurrentStateRecord snapshot.
 *
 * Precedence (fail-closed toward explicit labels):
 *   OFFLINE → CONFLICTED → UNKNOWN → STALE → AGING → FRESH
 */
export function computeFreshness({
  observed_at,
  max_age_seconds,
  now = Date.now(),
  source_status = null,
  conflict_status = 'NONE',
  force_freshness = null,
} = {}) {
  if (force_freshness) {
    if (!FRESHNESS_VALUES.includes(force_freshness)) {
      throw new ReconciliationError('INVALID_FRESHNESS', `invalid freshness ${force_freshness}`);
    }
    return force_freshness;
  }

  if (source_status === 'OFFLINE' || source_status === 'UNREACHABLE') {
    return 'OFFLINE';
  }

  if (
    conflict_status === 'PENDING_LOCAL_EFFECT'
    || conflict_status === 'SOURCE_CONFLICT'
  ) {
    return 'CONFLICTED';
  }

  if (source_status === 'UNKNOWN' || source_status === 'STALE') {
    return source_status === 'STALE' ? 'STALE' : 'UNKNOWN';
  }

  const observedMs = toMs(observed_at);
  const nowMs = toMs(now) ?? Date.now();
  if (observedMs == null || max_age_seconds == null || !(max_age_seconds >= 0)) {
    return 'UNKNOWN';
  }

  const ageSeconds = Math.max(0, (nowMs - observedMs) / 1000);
  if (ageSeconds > max_age_seconds) return 'STALE';
  if (ageSeconds > max_age_seconds * AGING_RATIO) return 'AGING';
  return 'FRESH';
}

/**
 * Two authoritative evidence refs conflict when they disagree on the same
 * subject/state key with equal authority and incompatible values.
 */
export function detectSourceConflict(evidenceA, evidenceB) {
  if (!evidenceA || !evidenceB) return false;
  if (evidenceA.authoritative !== true || evidenceB.authoritative !== true) return false;
  const keyA = evidenceA.state_key ?? evidenceA.subject_ref;
  const keyB = evidenceB.state_key ?? evidenceB.subject_ref;
  if (!keyA || keyA !== keyB) return false;
  if (evidenceA.source_system && evidenceB.source_system
      && evidenceA.source_system === evidenceB.source_system
      && evidenceA.evidence_ref === evidenceB.evidence_ref) {
    return false;
  }
  return stableValueHash(evidenceA.value) !== stableValueHash(evidenceB.value);
}

/**
 * Build a validated CurrentStateRecord-shaped object (contract_version=1).
 */
export function buildCurrentStateRecord(input) {
  const required = [
    'tenant_id',
    'state_key',
    'domain',
    'subject_ref',
    'value',
    'state_version',
    'source_system',
    'as_of',
    'observed_at',
    'max_age_seconds',
  ];
  for (const key of required) {
    if (input[key] === undefined || input[key] === null) {
      throw new ReconciliationError('INVALID_STATE_RECORD', `missing required field ${key}`);
    }
  }

  const conflict_status = input.conflict_status ?? 'NONE';
  if (!CONFLICT_STATUS_VALUES.includes(conflict_status)) {
    throw new ReconciliationError('INVALID_CONFLICT_STATUS', `invalid conflict_status ${conflict_status}`);
  }

  const freshness = input.freshness ?? computeFreshness({
    observed_at: input.observed_at,
    max_age_seconds: input.max_age_seconds,
    now: input.now,
    source_status: input.source_status,
    conflict_status,
  });
  if (!FRESHNESS_VALUES.includes(freshness)) {
    throw new ReconciliationError('INVALID_FRESHNESS', `invalid freshness ${freshness}`);
  }

  return {
    contract_version: 1,
    tenant_id: input.tenant_id,
    state_key: input.state_key,
    domain: input.domain,
    subject_ref: input.subject_ref,
    value: input.value,
    state_version: String(input.state_version),
    source_system: input.source_system,
    as_of: input.as_of,
    observed_at: input.observed_at,
    verified_at: input.verified_at ?? null,
    max_age_seconds: Number(input.max_age_seconds),
    freshness,
    conflict_status,
    last_event_id: input.last_event_id ?? null,
    evidence_refs: Array.isArray(input.evidence_refs) ? input.evidence_refs : [],
    // Optional reconcile input annotation (not a CurrentStateRecord DB column).
    ...(input.source_status ? { source_status: input.source_status } : {}),
  };
}

/**
 * Core reconcile decision for one materialized state key.
 *
 * Acceptance coverage:
 *   #36 provider mismatch, no pending local effect → REPAIR or ESCALATE
 *   #37 pending/ambiguous local effect → HOLD_CONFLICTED (never overwrite value)
 *   #38 stale/unknown source → MARK_STALE / MARK_UNKNOWN
 *   #39 conflicting authoritative evidence → HOLD_CONFLICTED (SOURCE_CONFLICT)
 *
 * @returns {{
 *   action: 'REPAIR'|'ESCALATE'|'HOLD_CONFLICTED'|'MARK_STALE'|'MARK_UNKNOWN'|'NOOP',
 *   next_state: object,
 *   reason: string,
 *   value_overwritten: boolean
 * }}
 */
export function reconcile({
  localState,
  providerObservation = null,
  localEffect = null,
  conflictingEvidence = null,
  now = new Date().toISOString(),
  escalateOnMismatch = false,
} = {}) {
  assertBusinessWriteAutonomyDisabled();
  if (!localState) {
    throw new ReconciliationError('MISSING_LOCAL_STATE', 'localState is required');
  }

  const base = buildCurrentStateRecord({
    ...localState,
    now,
  });

  // #39 conflicting authoritative evidence → CONFLICTED, never clobber.
  if (conflictingEvidence && detectSourceConflict(
    { ...base, authoritative: true, evidence_ref: (base.evidence_refs || [])[0] ?? 'local' },
    conflictingEvidence,
  )) {
    return {
      action: 'HOLD_CONFLICTED',
      value_overwritten: false,
      reason: 'conflicting authoritative evidence; mark CONFLICTED (SOURCE_CONFLICT)',
      next_state: {
        ...base,
        freshness: 'CONFLICTED',
        conflict_status: 'SOURCE_CONFLICT',
        observed_at: now,
        value: base.value,
      },
    };
  }

  // #37 pending/ambiguous local effect → CONFLICTED; never overwrite as drift.
  if (isBlockingLocalEffect(localEffect)) {
    return {
      action: 'HOLD_CONFLICTED',
      value_overwritten: false,
      reason: 'pending/ambiguous local effect cannot be auto-overwritten as drift',
      next_state: {
        ...base,
        freshness: 'CONFLICTED',
        conflict_status: 'PENDING_LOCAL_EFFECT',
        observed_at: now,
        value: base.value,
      },
    };
  }

  // #38 stale / offline / unknown source labeling (no provider repair path).
  const sourceStatus = providerObservation?.source_status
    ?? localState.source_status
    ?? null;

  if (sourceStatus === 'OFFLINE' || sourceStatus === 'UNREACHABLE') {
    return {
      action: 'MARK_UNKNOWN',
      value_overwritten: false,
      reason: 'source offline; freshness OFFLINE',
      next_state: {
        ...base,
        freshness: 'OFFLINE',
        conflict_status: 'NONE',
        observed_at: now,
        value: base.value,
      },
    };
  }

  if (sourceStatus === 'UNKNOWN') {
    return {
      action: 'MARK_UNKNOWN',
      value_overwritten: false,
      reason: 'source status UNKNOWN',
      next_state: {
        ...base,
        freshness: 'UNKNOWN',
        conflict_status: base.conflict_status === 'NONE' ? 'UNKNOWN' : base.conflict_status,
        observed_at: now,
        value: base.value,
      },
    };
  }

  // Age-based freshness when no provider observation to reconcile.
  if (!providerObservation) {
    const freshness = computeFreshness({
      observed_at: base.observed_at,
      max_age_seconds: base.max_age_seconds,
      now,
      source_status: sourceStatus,
      conflict_status: base.conflict_status,
    });
    if (freshness === 'STALE') {
      return {
        action: 'MARK_STALE',
        value_overwritten: false,
        reason: 'observed_at exceeds max_age_seconds',
        next_state: { ...base, freshness: 'STALE', conflict_status: 'NONE' },
      };
    }
    if (freshness === 'UNKNOWN') {
      return {
        action: 'MARK_UNKNOWN',
        value_overwritten: false,
        reason: 'insufficient observation metadata',
        next_state: { ...base, freshness: 'UNKNOWN' },
      };
    }
    return {
      action: 'NOOP',
      value_overwritten: false,
      reason: `no provider observation; freshness ${freshness}`,
      next_state: { ...base, freshness },
    };
  }

  // Provider observation present — evaluate mismatch / repair.
  const providerValue = providerObservation.value;
  const mismatch = stableValueHash(base.value) !== stableValueHash(providerValue);
  const observedAt = providerObservation.observed_at ?? now;
  const asOf = providerObservation.as_of ?? observedAt;
  const providerFreshness = computeFreshness({
    observed_at: observedAt,
    max_age_seconds: providerObservation.max_age_seconds ?? base.max_age_seconds,
    now,
    source_status: providerObservation.source_status ?? null,
    conflict_status: 'NONE',
  });

  if (providerFreshness === 'STALE' || providerObservation.source_status === 'STALE') {
    return {
      action: 'MARK_STALE',
      value_overwritten: false,
      reason: 'provider observation is STALE; refuse silent materialization',
      next_state: {
        ...base,
        freshness: 'STALE',
        conflict_status: 'NONE',
        observed_at: observedAt,
        value: base.value,
      },
    };
  }

  if (providerFreshness === 'UNKNOWN' || providerObservation.source_status === 'UNKNOWN') {
    return {
      action: 'MARK_UNKNOWN',
      value_overwritten: false,
      reason: 'provider observation is UNKNOWN',
      next_state: {
        ...base,
        freshness: 'UNKNOWN',
        conflict_status: 'UNKNOWN',
        observed_at: observedAt,
        value: base.value,
      },
    };
  }

  if (!mismatch) {
    return {
      action: 'NOOP',
      value_overwritten: false,
      reason: 'provider matches local state',
      next_state: {
        ...base,
        freshness: providerFreshness,
        conflict_status: 'NONE',
        observed_at: observedAt,
        as_of: asOf,
        verified_at: now,
        source_system: providerObservation.source_system ?? base.source_system,
        evidence_refs: providerObservation.evidence_ref
          ? [...new Set([...(base.evidence_refs || []), providerObservation.evidence_ref])]
          : base.evidence_refs,
      },
    };
  }

  // #36 provider mismatch with no local pending effect → repair or escalate.
  if (escalateOnMismatch || providerObservation.incomplete === true) {
    return {
      action: 'ESCALATE',
      value_overwritten: false,
      reason: providerObservation.incomplete
        ? 'provider mismatch with incomplete observation; escalate'
        : 'provider mismatch; escalateOnMismatch requested',
      next_state: {
        ...base,
        freshness: 'UNKNOWN',
        conflict_status: 'UNKNOWN',
        observed_at: observedAt,
        value: base.value,
      },
    };
  }

  const nextVersion = providerObservation.state_version
    ?? String(Number.parseInt(base.state_version, 10) + 1 || Date.now());

  return {
    action: 'REPAIR',
    value_overwritten: true,
    reason: 'provider mismatch with no pending local effect; safe projection repair',
    next_state: {
      ...base,
      value: providerValue,
      state_version: String(nextVersion),
      source_system: providerObservation.source_system ?? base.source_system,
      as_of: asOf,
      observed_at: observedAt,
      verified_at: now,
      freshness: providerFreshness === 'FRESH' || providerFreshness === 'AGING'
        ? providerFreshness
        : 'FRESH',
      conflict_status: 'NONE',
      last_event_id: providerObservation.event_id ?? base.last_event_id,
      evidence_refs: providerObservation.evidence_ref
        ? [...new Set([...(base.evidence_refs || []), providerObservation.evidence_ref])]
        : base.evidence_refs,
    },
  };
}

async function requireTenant(backend) {
  const r = await backend.query('SELECT cur_tenant() AS t;');
  const t = r.rows[0]?.t;
  if (!t) {
    throw new ReconciliationError('MISSING_TENANT_CONTEXT', 'missing tenant context (fail-closed)');
  }
  return t;
}

/**
 * Persist a reconcile decision onto current_state_records.
 * Never inserts provider value when value_overwritten is false and action is HOLD_*.
 */
export async function applyReconciliation(backend, { stateKey, decision }) {
  assertBusinessWriteAutonomyDisabled();
  const tenantId = await requireTenant(backend);
  if (!decision?.next_state) {
    throw new ReconciliationError('MISSING_DECISION', 'decision.next_state required');
  }
  if (decision.action === 'HOLD_CONFLICTED' && decision.value_overwritten) {
    throw new ReconciliationError(
      'STOP_CONDITION',
      'ambiguous local effect overwritten as drift',
      { action: decision.action },
    );
  }

  const ns = decision.next_state;
  const existing = await backend.query(
    `SELECT state_id, value, conflict_status, freshness
       FROM current_state_records
      WHERE tenant_id = $1 AND state_key = $2;`,
    [tenantId, stateKey],
  );

  if (existing.rows.length === 0) {
    const stateId = randomUUID();
    await backend.query(
      `INSERT INTO current_state_records (
         state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
         source_system, as_of, observed_at, verified_at, max_age_seconds,
         freshness, conflict_status, last_event_id, evidence_refs
       ) VALUES (
         $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb
       );`,
      [
        stateId,
        tenantId,
        ns.state_key,
        ns.domain,
        ns.subject_ref,
        JSON.stringify(ns.value),
        ns.state_version,
        ns.source_system,
        ns.as_of,
        ns.observed_at,
        ns.verified_at,
        ns.max_age_seconds,
        ns.freshness,
        ns.conflict_status,
        ns.last_event_id,
        JSON.stringify(ns.evidence_refs ?? []),
      ],
    );
    return { state_id: stateId, inserted: true, decision };
  }

  const priorValue = existing.rows[0].value;
  // Hard stop: HOLD_CONFLICTED must preserve prior value bytes.
  if (decision.action === 'HOLD_CONFLICTED') {
    const priorHash = stableValueHash(priorValue);
    const nextHash = stableValueHash(ns.value);
    if (priorHash !== nextHash) {
      throw new ReconciliationError(
        'STOP_CONDITION',
        'ambiguous local effect overwritten as drift',
        { prior: priorValue, next: ns.value },
      );
    }
  }

  await backend.query(
    `UPDATE current_state_records SET
       value = $3::jsonb,
       state_version = $4,
       source_system = $5,
       as_of = $6,
       observed_at = $7,
       verified_at = $8,
       max_age_seconds = $9,
       freshness = $10,
       conflict_status = $11,
       last_event_id = $12,
       evidence_refs = $13::jsonb
     WHERE tenant_id = $1 AND state_key = $2;`,
    [
      tenantId,
      stateKey,
      JSON.stringify(ns.value),
      ns.state_version,
      ns.source_system,
      ns.as_of,
      ns.observed_at,
      ns.verified_at,
      ns.max_age_seconds,
      ns.freshness,
      ns.conflict_status,
      ns.last_event_id,
      JSON.stringify(ns.evidence_refs ?? []),
    ],
  );

  return { state_id: existing.rows[0].state_id, inserted: false, decision };
}

/**
 * Look up whether the effect ledger has a blocking local effect for this tenant.
 * Optional subject filter via request_hash / capability_id when provided.
 */
export async function loadBlockingLocalEffect(backend, {
  capabilityId = null,
  idempotencyKey = null,
} = {}) {
  await requireTenant(backend);
  const params = [];
  const clauses = [
    `(status IN ('PENDING','COMMITTED')
      OR postcondition_status IN ('AMBIGUOUS','UNKNOWN','UNVERIFIED')
      OR outcome = 'AMBIGUOUS')`,
  ];
  if (capabilityId) {
    params.push(capabilityId);
    clauses.push(`capability_id = $${params.length}`);
  }
  if (idempotencyKey) {
    params.push(idempotencyKey);
    clauses.push(`idempotency_key = $${params.length}`);
  }

  const r = await backend.query(
    `SELECT effect_id, status, postcondition_status, outcome, idempotency_key, capability_id
       FROM effect_ledger
      WHERE ${clauses.join(' AND ')}
      ORDER BY started_at DESC
      LIMIT 1;`,
    params,
  );
  return r.rows[0] ?? null;
}

export function createReconciliationRuntime(db, { trustedTenantId } = {}) {
  assertBusinessWriteAutonomyDisabled();
  if (!trustedTenantId) {
    throw new ReconciliationError('MISSING_TENANT_CONTEXT', 'trustedTenantId required (fail-closed)');
  }

  return {
    tenantId: trustedTenantId,
    businessWriteAutonomy: BUSINESS_WRITE_AUTONOMY,

    async reconcileState(tx, args) {
      const tenant = await requireTenant(tx);
      if (tenant !== trustedTenantId) {
        throw new ReconciliationError(
          'TENANT_MISMATCH',
          'tx tenant does not match trustedTenantId',
          { tenant, trustedTenantId },
        );
      }

      let localEffect = args.localEffect ?? null;
      if (localEffect === undefined || localEffect === null) {
        if (args.autoLoadLocalEffect !== false) {
          localEffect = await loadBlockingLocalEffect(tx, {
            capabilityId: args.capabilityId,
            idempotencyKey: args.idempotencyKey,
          });
        }
      }

      const decision = reconcile({
        localState: args.localState,
        providerObservation: args.providerObservation ?? null,
        localEffect,
        conflictingEvidence: args.conflictingEvidence ?? null,
        now: args.now,
        escalateOnMismatch: args.escalateOnMismatch === true,
      });

      const applied = await applyReconciliation(tx, {
        stateKey: args.localState.state_key,
        decision,
      });

      return { ...applied, decision };
    },
  };
}
