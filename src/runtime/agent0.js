// src/runtime/agent0.js
// Agent 0 T0/T1 read-only routines per 05_PRODUCT_BEHAVIOR.md and
// 12_ACCEPTANCE_AND_IMPLEMENTATION.md V1.0B.
//
// T0: observe tenant state from evidence-backed read surfaces only.
// T1: recommend/draft from observations — no material writes.
// Business-write autonomy remains DISABLED.

import { randomUUID } from 'node:crypto';
import {
  assertBusinessWriteAutonomyDisabled,
  BUSINESS_WRITE_AUTONOMY,
} from './autonomy.js';
import { CONFIDENTIALITY_CLASSES } from './durable-memory.js';

export const AGENT0_AUTONOMY_LEVELS = Object.freeze([
  'T0', 'T1', 'T2', 'T3', 'T4', 'T5',
]);

export const CONTEXT_SOURCES = Object.freeze([
  'explicit_selector',
  'explicit_language',
  'unique_entity',
  'recent_explicit_context',
  'portfolio',
]);

export class Agent0Error extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'Agent0Error';
    this.code = code;
    this.details = details;
  }
}

export function validateContextEnvelope(envelope = {}) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Agent0Error('INVALID_CONTEXT', 'ContextEnvelope required');
  }
  if (envelope.contract_version !== 1) {
    throw new Agent0Error('INVALID_CONTEXT', 'ContextEnvelope.contract_version must be 1');
  }
  if (!Array.isArray(envelope.authorized_tenant_ids) || envelope.authorized_tenant_ids.length === 0) {
    throw new Agent0Error('INVALID_CONTEXT', 'authorized_tenant_ids required');
  }
  if (!CONTEXT_SOURCES.includes(envelope.context_source)) {
    throw new Agent0Error('INVALID_CONTEXT', `invalid context_source: ${envelope.context_source}`);
  }
  if (envelope.active_tenant_id == null && envelope.context_source !== 'portfolio') {
    throw new Agent0Error('INVALID_CONTEXT', 'active_tenant_id required unless portfolio context');
  }
  return envelope;
}

async function requireTenant(tx, trustedTenantId) {
  const r = await tx.query('SELECT require_tenant() AS tenant_id;');
  const tenant = r.rows[0]?.tenant_id;
  if (tenant !== trustedTenantId) {
    throw new Agent0Error('TENANT_MISMATCH', 'trusted tenant context mismatch', {
      tenant,
      trustedTenantId,
    });
  }
  return tenant;
}

/**
 * T0 — observe read-only tenant state from canonical read surfaces.
 */
export async function observeTenant(backend, {
  tenant_id,
  context_envelope,
  limit = 50,
}) {
  assertBusinessWriteAutonomyDisabled();
  validateContextEnvelope(context_envelope);
  if (!context_envelope.authorized_tenant_ids.includes(tenant_id)) {
    throw new Agent0Error('TENANT_NOT_AUTHORIZED', 'tenant not in authorized context');
  }

  return backend.tx(async (tx) => {
    await tx.query('SELECT set_tenant($1);', [tenant_id]);
    await requireTenant(tx, tenant_id);

    const tenantRow = (
      await tx.query(
        'SELECT tenant_id, name, confidentiality_class FROM tenants WHERE tenant_id = $1;',
        [tenant_id],
      )
    ).rows[0];
    if (!tenantRow) {
      throw new Agent0Error('TENANT_NOT_FOUND', `tenant ${tenant_id} not found`);
    }

    const states = (
      await tx.query(
        `SELECT state_key, domain, subject_ref, value, freshness, conflict_status,
                observed_at, evidence_refs
         FROM current_state_records
         ORDER BY observed_at DESC
         LIMIT $1;`,
        [limit],
      )
    ).rows;

    const attention = (
      await tx.query(
        `SELECT attention_id, condition_key, severity, owner_action_required,
                event_class, status, state_hash, evidence_refs
         FROM attention_items
         WHERE status = 'open'
         ORDER BY last_material_change_at DESC NULLS LAST
         LIMIT $1;`,
        [limit],
      )
    ).rows;

    const events = (
      await tx.query(
        `SELECT event_id, event_type, authenticity_status, received_at, subject_refs
         FROM canonical_events
         WHERE authenticity_status IN ('VERIFIED', 'NOT_APPLICABLE')
         ORDER BY received_at DESC
         LIMIT $1;`,
        [limit],
      )
    ).rows;

    const connectors = (
      await tx.query(
        `SELECT connector_id, provider, access_mode, status
         FROM connectors
         WHERE status = 'active'
         ORDER BY connector_id;`,
      )
    ).rows;

    return {
      observation_id: randomUUID(),
      autonomy_level: 'T0',
      tenant_id,
      confidentiality_class: tenantRow.confidentiality_class,
      observed_at: new Date().toISOString(),
      state_records: states,
      open_attention_items: attention,
      recent_verified_events: events,
      active_connectors: connectors,
      evidence_refs: [
        ...states.flatMap((s) => s.evidence_refs || []),
        ...attention.flatMap((a) => a.evidence_refs || []),
      ],
      business_write_autonomy: BUSINESS_WRITE_AUTONOMY,
    };
  });
}

/**
 * T1 — recommend/draft from a T0 observation. No writes.
 */
export function recommendDraft({
  observation,
  routine_id = 'agent0.default',
  context_envelope,
}) {
  assertBusinessWriteAutonomyDisabled();
  validateContextEnvelope(context_envelope);
  if (!observation || observation.autonomy_level !== 'T0') {
    throw new Agent0Error('INVALID_OBSERVATION', 'T1 requires a T0 observation');
  }
  if (!context_envelope.authorized_tenant_ids.includes(observation.tenant_id)) {
    throw new Agent0Error('TENANT_NOT_AUTHORIZED', 'tenant not in authorized context');
  }

  const needsOwner = observation.open_attention_items.filter((a) => a.owner_action_required);
  const stale = observation.state_records.filter((s) =>
    ['STALE', 'OFFLINE', 'CONFLICTED', 'UNKNOWN'].includes(s.freshness),
  );
  const risks = observation.open_attention_items.filter((a) =>
    ['CRITICAL', 'HIGH'].includes(a.severity),
  );

  const recommendations = [];
  if (needsOwner.length > 0) {
    recommendations.push({
      kind: 'owner_attention',
      priority: 'high',
      summary: `${needsOwner.length} open item(s) require owner action`,
      evidence_refs: needsOwner.flatMap((a) => a.evidence_refs || []),
    });
  }
  if (stale.length > 0) {
    recommendations.push({
      kind: 'reconcile_read_path',
      priority: 'medium',
      summary: `${stale.length} state record(s) are stale/conflicted/offline`,
      evidence_refs: stale.flatMap((s) => s.evidence_refs || []),
    });
  }
  if (risks.length > 0) {
    recommendations.push({
      kind: 'risk_review',
      priority: 'high',
      summary: `${risks.length} risk attention item(s) open`,
      evidence_refs: risks.flatMap((a) => a.evidence_refs || []),
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      kind: 'continue_observe',
      priority: 'low',
      summary: 'No material read-path action required; continue T0 observation',
      evidence_refs: observation.evidence_refs?.slice(0, 5) || [],
    });
  }

  return {
    recommendation_id: randomUUID(),
    autonomy_level: 'T1',
    tenant_id: observation.tenant_id,
    routine_id,
    created_at: new Date().toISOString(),
    recommendations,
    draft: {
      title: `Agent 0 draft for ${routine_id}`,
      body: recommendations.map((r) => `- [${r.priority}] ${r.summary}`).join('\n'),
      attributed: true,
      content_trust: 'TRUSTED_STRUCTURED',
    },
    source_observation_id: observation.observation_id,
    business_write_autonomy: BUSINESS_WRITE_AUTONOMY,
  };
}

export function assertTenantReadableForPortfolio(tenantRow) {
  if (!CONFIDENTIALITY_CLASSES.includes(tenantRow.confidentiality_class)) {
    throw new Agent0Error(
      'UNKNOWN_CONFIDENTIALITY',
      `unknown confidentiality class: ${tenantRow.confidentiality_class}`,
    );
  }
  return tenantRow;
}
