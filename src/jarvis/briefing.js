// src/jarvis/briefing.js
// Jarvis owner briefing over evidence-backed read state (V1.0B).
//
// Default briefing shape per 05_PRODUCT_BEHAVIOR.md:
//   Changed → Needs You → Risks / Unknowns → Completed → Evidence
//
// Portfolio synthesis is limited to authorized FIRST_PARTY_PORTFOLIO tenants.
// THIRD_PARTY_ISOLATED tenants never contribute raw cross-tenant context.

import { randomUUID } from 'node:crypto';
import { asRole } from '../db/index.js';
import {
  observeTenant,
  recommendDraft,
  validateContextEnvelope,
  assertTenantReadableForPortfolio,
  Agent0Error,
} from '../runtime/agent0.js';
import { assertBusinessWriteAutonomyDisabled } from '../runtime/autonomy.js';

export class BriefingError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BriefingError';
    this.code = code;
    this.details = details;
  }
}

async function loadTenantMeta(db, tenantId) {
  const rows = await db.query(
    'SELECT tenant_id, name, confidentiality_class FROM tenants WHERE tenant_id = $1;',
    [tenantId],
  );
  return rows.rows[0] || null;
}

export async function synthesizeFirstPartyPortfolio(db, {
  context_envelope,
  authorized_tenant_ids,
  role = 'app_runtime',
}) {
  assertBusinessWriteAutonomyDisabled();
  validateContextEnvelope(context_envelope);
  const allowed = authorized_tenant_ids || context_envelope.authorized_tenant_ids;
  const portfolio = [];
  for (const tenantId of allowed) {
    const meta = await loadTenantMeta(db, tenantId);
    if (!meta) continue;
    assertTenantReadableForPortfolio(meta);
    if (meta.confidentiality_class !== 'FIRST_PARTY_PORTFOLIO') {
      throw new Agent0Error(
        'PORTFOLIO_ISOLATION',
        'third-party tenant cannot enter first-party portfolio synthesis',
        { tenant_id: tenantId, confidentiality_class: meta.confidentiality_class },
      );
    }
    const observation = await asRole(db, role, async (b) =>
      observeTenant(b, {
        tenant_id: tenantId,
        context_envelope: { ...context_envelope, active_tenant_id: tenantId },
      }),
    );
    portfolio.push({
      tenant_id: tenantId,
      tenant_name: meta.name,
      confidentiality_class: meta.confidentiality_class,
      observation_summary: {
        state_count: observation.state_records.length,
        open_attention: observation.open_attention_items.length,
        verified_events: observation.recent_verified_events.length,
      },
      observation_id: observation.observation_id,
    });
  }
  return {
    portfolio_id: randomUUID(),
    synthesized_at: new Date().toISOString(),
    tenants: portfolio,
    cross_tenant: portfolio.length > 1,
    context_source: 'portfolio',
  };
}

export async function buildOwnerBriefing(db, {
  context_envelope,
  authorized_tenant_ids,
  role = 'app_runtime',
}) {
  assertBusinessWriteAutonomyDisabled();
  validateContextEnvelope(context_envelope);
  const allowed = authorized_tenant_ids || context_envelope.authorized_tenant_ids;
  const changed = [];
  const needsYou = [];
  const risks = [];
  const completed = [];
  const evidence = [];

  for (const tenantId of allowed) {
    const observation = await asRole(db, role, async (b) =>
      observeTenant(b, {
        tenant_id: tenantId,
        context_envelope: { ...context_envelope, active_tenant_id: tenantId },
      }),
    );
    const recommendation = recommendDraft({
      observation,
      context_envelope: { ...context_envelope, active_tenant_id: tenantId },
    });

    for (const state of observation.state_records) {
      if (['AGING', 'STALE', 'CONFLICTED'].includes(state.freshness)) {
        changed.push({
          tenant_id: tenantId,
          kind: 'state_freshness',
          state_key: state.state_key,
          freshness: state.freshness,
          evidence_refs: state.evidence_refs || [],
        });
      }
    }

    for (const item of observation.open_attention_items) {
      if (item.owner_action_required) {
        needsYou.push({
          tenant_id: tenantId,
          attention_id: item.attention_id,
          condition_key: item.condition_key,
          severity: item.severity,
          evidence_refs: item.evidence_refs || [],
        });
      }
      if (['CRITICAL', 'HIGH'].includes(item.severity)) {
        risks.push({
          tenant_id: tenantId,
          attention_id: item.attention_id,
          event_class: item.event_class,
          severity: item.severity,
          evidence_refs: item.evidence_refs || [],
        });
      }
    }

    for (const rec of recommendation.recommendations) {
      if (rec.kind === 'continue_observe') {
        completed.push({
          tenant_id: tenantId,
          summary: rec.summary,
          evidence_refs: rec.evidence_refs || [],
        });
      }
      evidence.push(...(rec.evidence_refs || []));
    }
    evidence.push(...(observation.evidence_refs || []));
  }

  return {
    briefing_id: randomUUID(),
    generated_at: new Date().toISOString(),
    sections: {
      changed,
      needs_you: needsYou,
      risks_unknowns: risks,
      completed,
      evidence: [...new Set(evidence)],
    },
    recommendations_by_tenant: allowed.map((tenantId) => ({
      tenant_id: tenantId,
      note: 'evidence-backed read-only briefing',
    })),
    business_write_autonomy: false,
    content_trust: 'TRUSTED_STRUCTURED',
  };
}
