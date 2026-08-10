// src/runtime/observability.js
// F-12 Observability: receipts/trace linkage, attention items,
// non-silenceable classes, deterministic materiality.
//
// Per 10_OBSERVABILITY_RECOVERY.md and
// 01_ARCHITECTURE_LOCKS.md#Non-silenceable-classes:
//   authenticated event → normalize → dedupe → materialize → freshness
//   → materiality → SILENCE | BATCH | NOTIFY | WAKE
//
// An LLM/heuristic may increase urgency or summarize. It may NOT hide a
// non-silenceable event (acceptance #18; stop: non-silenceable class silenced).
//
// NON-SCOPE: business writes. Autonomy remains DISABLED.

import { createHash, randomUUID } from 'node:crypto';
import {
  assertBusinessWriteAutonomyDisabled,
  BUSINESS_WRITE_AUTONOMY,
} from './autonomy.js';

export const MATERIALITY_ACTIONS = Object.freeze([
  'SILENCE',
  'BATCH',
  'NOTIFY',
  'WAKE',
]);

/** Classes that cannot be reduced to SILENCE by an LLM/materiality heuristic. */
export const NON_SILENCEABLE_CLASSES = Object.freeze([
  'tenant_isolation_security',
  'credential_authentication_anomaly',
  'authority_permission_change',
  'kill_switch_fail_closed',
  'material_financial',
  'privacy_legal_opt_out',
  'unknown_ambiguous_customer_effect',
  'control_store_outage',
  'severe_production_fault',
]);

/** Healthy / no-op classes that must never wake a strong model (#19). */
export const HEALTHY_NOOP_CLASSES = Object.freeze([
  'healthy',
  'noop',
  'heartbeat',
  'health_check_ok',
  'provider_poll_empty',
  'idempotent_duplicate',
]);

const ACTION_RANK = Object.freeze({
  SILENCE: 0,
  BATCH: 1,
  NOTIFY: 2,
  WAKE: 3,
});

const CLASS_DEFAULT_ACTION = Object.freeze({
  tenant_isolation_security: 'WAKE',
  credential_authentication_anomaly: 'WAKE',
  authority_permission_change: 'NOTIFY',
  kill_switch_fail_closed: 'WAKE',
  material_financial: 'NOTIFY',
  privacy_legal_opt_out: 'NOTIFY',
  unknown_ambiguous_customer_effect: 'WAKE',
  control_store_outage: 'WAKE',
  severe_production_fault: 'WAKE',
});

const CLASS_DEFAULT_SEVERITY = Object.freeze({
  tenant_isolation_security: 'CRITICAL',
  credential_authentication_anomaly: 'CRITICAL',
  authority_permission_change: 'HIGH',
  kill_switch_fail_closed: 'CRITICAL',
  material_financial: 'HIGH',
  privacy_legal_opt_out: 'HIGH',
  unknown_ambiguous_customer_effect: 'HIGH',
  control_store_outage: 'CRITICAL',
  severe_production_fault: 'CRITICAL',
});

export class ObservabilityError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ObservabilityError';
    this.code = code;
    this.details = details;
  }
}

function stableHash(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableHash).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableHash(value[k])).join(',') + '}';
}

export function isNonSilenceable(eventClass) {
  return NON_SILENCEABLE_CLASSES.includes(eventClass);
}

export function isHealthyNoop(eventClass) {
  return HEALTHY_NOOP_CLASSES.includes(eventClass);
}

export function resolveEventClass(event = {}) {
  if (event.event_class) return event.event_class;
  if (event.class) return event.class;
  if (event.typed_properties?.event_class) return event.typed_properties.event_class;
  if (event.typed_properties?.class) return event.typed_properties.class;
  if (event.healthy === true || event.noop === true) return 'noop';
  if (event.event_type === 'system.heartbeat') return 'heartbeat';
  if (event.event_type === 'system.health.ok') return 'healthy';
  return event.event_type || 'unknown';
}

function maxAction(a, b) {
  return ACTION_RANK[a] >= ACTION_RANK[b] ? a : b;
}

/**
 * Deterministic materiality decision.
 * LLM suggestions may only raise urgency; they cannot SILENCE non-silenceable classes.
 */
export function evaluateMateriality(event, {
  llmSuggestion = null,
  forceSilence = false,
} = {}) {
  assertBusinessWriteAutonomyDisabled();

  const eventClass = resolveEventClass(event);
  const nonSilenceable = isNonSilenceable(eventClass);
  const healthyNoop = isHealthyNoop(eventClass);

  let action = 'SILENCE';
  let reason = 'no material delta';

  if (healthyNoop) {
    action = 'SILENCE';
    reason = 'healthy/no-op event';
  } else if (nonSilenceable) {
    action = CLASS_DEFAULT_ACTION[eventClass] || 'NOTIFY';
    reason = `non-silenceable class=${eventClass}`;
  } else if (event.material_delta === true || event.material === true) {
    action = 'NOTIFY';
    reason = 'material delta';
  } else if (event.batchable === true) {
    action = 'BATCH';
    reason = 'batchable non-critical delta';
  }

  // LLM / heuristic may increase urgency only.
  if (llmSuggestion && MATERIALITY_ACTIONS.includes(llmSuggestion)) {
    if (nonSilenceable && llmSuggestion === 'SILENCE') {
      // Stop condition: never honor silence of a non-silenceable class.
      reason = `${reason}; llm SILENCE blocked`;
    } else {
      action = maxAction(action, llmSuggestion);
      reason = `${reason}; llm raised to ${action}`;
    }
  }

  // Explicit forceSilence attempts are fail-closed for non-silenceable classes.
  if (forceSilence === true) {
    if (nonSilenceable) {
      throw new ObservabilityError(
        'NON_SILENCEABLE_SILENCED',
        `Refuse to SILENCE non-silenceable class=${eventClass}`,
        { event_class: eventClass }
      );
    }
    action = 'SILENCE';
    reason = 'forceSilence on silenceable class';
  }

  if (nonSilenceable && action === 'SILENCE') {
    throw new ObservabilityError(
      'NON_SILENCEABLE_SILENCED',
      `Non-silenceable class=${eventClass} cannot be SILENCED`,
      { event_class: eventClass }
    );
  }

  const strongModelWake = action === 'WAKE';
  const attentionRequired = nonSilenceable || ACTION_RANK[action] >= ACTION_RANK.NOTIFY;

  return Object.freeze({
    contract_version: 1,
    event_class: eventClass,
    action,
    non_silenceable: nonSilenceable,
    attention_required: attentionRequired,
    strong_model_wake: strongModelWake,
    severity: nonSilenceable
      ? (CLASS_DEFAULT_SEVERITY[eventClass] || 'HIGH')
      : (action === 'WAKE' ? 'HIGH' : action === 'NOTIFY' ? 'WARNING' : 'INFO'),
    reason,
    business_write_autonomy: BUSINESS_WRITE_AUTONOMY,
  });
}

/** Deterministic attention state hash for unresolved-state dedupe (#20). */
export function computeAttentionStateHash({
  condition_key,
  subject_ref = null,
  event_class = null,
  payload = null,
} = {}) {
  const digest = createHash('sha256')
    .update(stableHash({
      condition_key,
      subject_ref,
      event_class,
      payload,
    }), 'utf8')
    .digest('hex');
  return digest;
}

export function validateAttentionItem(item) {
  if (!item || typeof item !== 'object') {
    throw new ObservabilityError('INVALID_ATTENTION', 'attention item required');
  }
  if (!item.tenant_id) {
    throw new ObservabilityError('INVALID_ATTENTION', 'tenant_id required');
  }
  if (!item.condition_key) {
    throw new ObservabilityError('INVALID_ATTENTION', 'condition_key required');
  }
  if (!item.state_hash) {
    throw new ObservabilityError('INVALID_ATTENTION', 'state_hash required');
  }
  if (!item.event_class) {
    throw new ObservabilityError('INVALID_ATTENTION', 'event_class required');
  }
  if (item.non_silenceable === true && item.status === 'open'
      && item.severity === 'INFO' && item.owner_action_required === false) {
    throw new ObservabilityError(
      'NON_SILENCEABLE_SILENCED',
      'non-silenceable attention cannot be owner-invisible while open'
    );
  }
  return true;
}

/**
 * Open or refresh an attention item.
 * Same unresolved state_hash → no repeated notification (#20).
 * Returns { item, notified, material_change }.
 */
export async function openOrRefreshAttentionItem(backend, fields) {
  assertBusinessWriteAutonomyDisabled();

  const eventClass = fields.event_class;
  const nonSilenceable = fields.non_silenceable ?? isNonSilenceable(eventClass);
  const severity = fields.severity
    || CLASS_DEFAULT_SEVERITY[eventClass]
    || 'WARNING';
  const ownerActionRequired = fields.owner_action_required ?? nonSilenceable;
  const stateHash = fields.state_hash
    || computeAttentionStateHash({
      condition_key: fields.condition_key,
      subject_ref: fields.subject_ref ?? null,
      event_class: eventClass,
      payload: fields.payload ?? null,
    });

  const candidate = {
    tenant_id: fields.tenant_id,
    condition_key: fields.condition_key,
    state_hash: stateHash,
    severity,
    owner_action_required: ownerActionRequired,
    event_class: eventClass,
    non_silenceable: nonSilenceable,
    status: fields.status || 'open',
    source_refs: fields.source_refs || [],
    evidence_refs: fields.evidence_refs || [],
    receipt_id: fields.receipt_id ?? null,
    trace_id: fields.trace_id ?? null,
  };
  validateAttentionItem(candidate);

  const existing = await backend.query(
    `SELECT attention_id, tenant_id, condition_key, state_hash, severity,
            owner_action_required, event_class, non_silenceable, status,
            first_opened_at, last_material_change_at, last_notified_at,
            notify_count, source_refs, evidence_refs, receipt_id, trace_id
     FROM attention_items
     WHERE tenant_id = $1 AND condition_key = $2;`,
    [candidate.tenant_id, candidate.condition_key]
  );

  const now = fields.now || new Date().toISOString();

  if (existing.rows[0]) {
    const row = existing.rows[0];
    const unresolved = row.status === 'open' || row.status === 'acked' || row.status === 'snoozed';
    if (unresolved && row.state_hash === stateHash) {
      // Same unresolved state → do NOT repeatedly notify.
      return {
        item: mapAttentionRow(row),
        notified: false,
        material_change: false,
      };
    }

    const notified = true;
    const r = await backend.query(
      `UPDATE attention_items SET
         state_hash = $3,
         severity = $4,
         owner_action_required = $5,
         event_class = $6,
         non_silenceable = $7,
         status = 'open',
         last_material_change_at = $8::timestamptz,
         last_notified_at = $8::timestamptz,
         notify_count = notify_count + 1,
         source_refs = $9::jsonb,
         evidence_refs = $10::jsonb,
         receipt_id = COALESCE($11::uuid, receipt_id),
         trace_id = COALESCE($12::uuid, trace_id)
       WHERE attention_id = $1 AND tenant_id = $2
       RETURNING attention_id, tenant_id, condition_key, state_hash, severity,
                 owner_action_required, event_class, non_silenceable, status,
                 first_opened_at, last_material_change_at, last_notified_at,
                 notify_count, source_refs, evidence_refs, receipt_id, trace_id;`,
      [
        row.attention_id,
        candidate.tenant_id,
        stateHash,
        severity,
        ownerActionRequired,
        eventClass,
        nonSilenceable,
        now,
        JSON.stringify(candidate.source_refs),
        JSON.stringify(candidate.evidence_refs),
        candidate.receipt_id,
        candidate.trace_id,
      ]
    );
    return {
      item: mapAttentionRow(r.rows[0]),
      notified,
      material_change: true,
    };
  }

  const attentionId = fields.attention_id || randomUUID();
  const r = await backend.query(
    `INSERT INTO attention_items (
       attention_id, tenant_id, condition_key, state_hash, severity,
       owner_action_required, event_class, non_silenceable, status,
       first_opened_at, last_material_change_at, last_notified_at, notify_count,
       source_refs, evidence_refs, receipt_id, trace_id
     ) VALUES (
       $1,$2,$3,$4,$5,
       $6,$7,$8,'open',
       $9::timestamptz,$9::timestamptz,$9::timestamptz,1,
       $10::jsonb,$11::jsonb,$12::uuid,$13::uuid
     )
     RETURNING attention_id, tenant_id, condition_key, state_hash, severity,
               owner_action_required, event_class, non_silenceable, status,
               first_opened_at, last_material_change_at, last_notified_at,
               notify_count, source_refs, evidence_refs, receipt_id, trace_id;`,
    [
      attentionId,
      candidate.tenant_id,
      candidate.condition_key,
      stateHash,
      severity,
      ownerActionRequired,
      eventClass,
      nonSilenceable,
      now,
      JSON.stringify(candidate.source_refs),
      JSON.stringify(candidate.evidence_refs),
      candidate.receipt_id,
      candidate.trace_id,
    ]
  );
  return {
    item: mapAttentionRow(r.rows[0]),
    notified: true,
    material_change: true,
  };
}

function mapAttentionRow(row) {
  return {
    contract_version: 1,
    attention_id: row.attention_id,
    tenant_id: row.tenant_id,
    condition_key: row.condition_key,
    state_hash: row.state_hash,
    severity: row.severity,
    owner_action_required: row.owner_action_required,
    event_class: row.event_class,
    non_silenceable: row.non_silenceable,
    status: row.status,
    first_opened_at: row.first_opened_at,
    last_material_change_at: row.last_material_change_at,
    last_notified_at: row.last_notified_at,
    notify_count: Number(row.notify_count),
    source_refs: row.source_refs,
    evidence_refs: row.evidence_refs,
    receipt_id: row.receipt_id,
    trace_id: row.trace_id,
  };
}

export async function createExecutionTrace(backend, fields = {}) {
  assertBusinessWriteAutonomyDisabled();
  if (!fields.tenant_id) {
    throw new ObservabilityError('INVALID_TRACE', 'tenant_id required');
  }
  const traceId = fields.trace_id || randomUUID();
  await backend.query(
    `INSERT INTO execution_traces (
       trace_id, tenant_id, workflow_id, root_span, parent_trace_id,
       started_at, status, attributes
     ) VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now()), $7, $8::jsonb);`,
    [
      traceId,
      fields.tenant_id,
      fields.workflow_id ?? null,
      fields.root_span || 'execution',
      fields.parent_trace_id ?? null,
      fields.started_at ?? null,
      fields.status || 'open',
      JSON.stringify(fields.attributes || {}),
    ]
  );
  return { trace_id: traceId, tenant_id: fields.tenant_id };
}

/**
 * Bind an existing execution_receipt to a trace (receipts/trace linkage).
 * Does not perform business writes.
 */
export async function linkReceiptToTrace(backend, { receipt_id, trace_id, tenant_id }) {
  assertBusinessWriteAutonomyDisabled();
  if (!receipt_id || !trace_id || !tenant_id) {
    throw new ObservabilityError(
      'INVALID_LINK',
      'receipt_id, trace_id, and tenant_id are required'
    );
  }

  const trace = await backend.query(
    `SELECT trace_id FROM execution_traces WHERE trace_id = $1 AND tenant_id = $2;`,
    [trace_id, tenant_id]
  );
  if (!trace.rows[0]) {
    throw new ObservabilityError('TRACE_NOT_FOUND', `trace_id=${trace_id} not found`);
  }

  const r = await backend.query(
    `UPDATE execution_receipts
     SET trace_id = $1
     WHERE receipt_id = $2 AND tenant_id = $3
     RETURNING receipt_id, trace_id, tenant_id, workflow_id, step_id, verification_status;`,
    [trace_id, receipt_id, tenant_id]
  );
  if (!r.rows[0]) {
    throw new ObservabilityError('RECEIPT_NOT_FOUND', `receipt_id=${receipt_id} not found`);
  }
  return {
    receipt_id: r.rows[0].receipt_id,
    trace_id: r.rows[0].trace_id,
    tenant_id: r.rows[0].tenant_id,
    workflow_id: r.rows[0].workflow_id,
    step_id: r.rows[0].step_id,
    verification_status: r.rows[0].verification_status,
  };
}

export async function resolveReceiptTrace(backend, { receipt_id, tenant_id }) {
  const r = await backend.query(
    `SELECT r.receipt_id, r.trace_id, r.tenant_id, r.workflow_id, r.step_id,
            r.verification_status, t.root_span, t.status AS trace_status,
            t.started_at AS trace_started_at, t.attributes AS trace_attributes
     FROM execution_receipts r
     LEFT JOIN execution_traces t
       ON t.trace_id = r.trace_id AND t.tenant_id = r.tenant_id
     WHERE r.receipt_id = $1 AND r.tenant_id = $2;`,
    [receipt_id, tenant_id]
  );
  if (!r.rows[0]) {
    throw new ObservabilityError('RECEIPT_NOT_FOUND', `receipt_id=${receipt_id} not found`);
  }
  const row = r.rows[0];
  return {
    receipt_id: row.receipt_id,
    trace_id: row.trace_id,
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    step_id: row.step_id,
    verification_status: row.verification_status,
    trace: row.trace_status == null ? null : {
      trace_id: row.trace_id,
      root_span: row.root_span,
      status: row.trace_status,
      started_at: row.trace_started_at,
      attributes: row.trace_attributes,
    },
  };
}

/**
 * In-memory materiality runtime with wake/notify counters for acceptance #19/#20.
 */
export function createMaterialityRuntime() {
  assertBusinessWriteAutonomyDisabled();
  const metrics = {
    events_processed: 0,
    strong_model_wakes: 0,
    notifications: 0,
    silences: 0,
    batches: 0,
    non_silenceable_blocks: 0,
    attention_opens: 0,
    attention_repeat_suppressed: 0,
  };

  return {
    metrics,
    evaluate(event, opts = {}) {
      try {
        const decision = evaluateMateriality(event, opts);
        metrics.events_processed += 1;
        if (decision.action === 'SILENCE') metrics.silences += 1;
        if (decision.action === 'BATCH') metrics.batches += 1;
        if (decision.action === 'NOTIFY') metrics.notifications += 1;
        if (decision.strong_model_wake) metrics.strong_model_wakes += 1;
        return decision;
      } catch (e) {
        if (e instanceof ObservabilityError && e.code === 'NON_SILENCEABLE_SILENCED') {
          metrics.non_silenceable_blocks += 1;
        }
        throw e;
      }
    },
    async attend(backend, fields) {
      const result = await openOrRefreshAttentionItem(backend, fields);
      if (result.notified) metrics.notifications += 1;
      else metrics.attention_repeat_suppressed += 1;
      if (result.material_change && result.item.notify_count === 1) {
        metrics.attention_opens += 1;
      }
      return result;
    },
  };
}

/**
 * Process a stream of events through deterministic materiality.
 * Used by acceptance #19 for bulk healthy/no-op compression.
 */
export function processEventBatch(events, runtime = createMaterialityRuntime()) {
  const decisions = [];
  for (const event of events) {
    decisions.push(runtime.evaluate(event));
  }
  return { decisions, metrics: { ...runtime.metrics } };
}
