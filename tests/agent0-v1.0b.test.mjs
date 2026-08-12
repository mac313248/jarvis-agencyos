// tests/agent0-v1.0b.test.mjs
// V1.0B Agent 0 T0/T1 + Jarvis owner briefing acceptance.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import {
  observeTenant,
  recommendDraft,
  Agent0Error,
} from '../src/runtime/agent0.js';
import {
  buildOwnerBriefing,
  synthesizeFirstPartyPortfolio,
} from '../src/jarvis/briefing.js';
import {
  AGENT0_T0_T1_READ,
  BUSINESS_WRITE_AUTONOMY,
} from '../src/runtime/autonomy.js';
import { openOrRefreshAttentionItem } from '../src/runtime/observability.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function contextFor(tenantId, extra = {}) {
  return {
    contract_version: 1,
    request_id: randomUUID(),
    principal_id: 'owner@test',
    authorized_tenant_ids: [tenantId],
    active_tenant_id: tenantId,
    tenant_confidentiality_class: extra.confidentiality_class ?? 'FIRST_PARTY_PORTFOLIO',
    context_source: 'explicit_selector',
    cross_tenant: false,
    context_epoch: 1,
    confidence: 'exact',
  };
}

before(async () => {
  db = await freshCluster({ unique: 'agent0-v1.0b' });
  await seedTwoTenants(db, { aId: A, bId: B });
  await db.query(
    `INSERT INTO current_state_records (
       state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
       source_system, as_of, observed_at, max_age_seconds, freshness, conflict_status
     ) VALUES (
       $1, $2, 'crm.contact:c-1', 'crm', 'contact:c-1', $3::jsonb, '1',
       'fixture', $4::timestamptz, $4::timestamptz, 60, 'STALE', 'NONE'
     );`,
    [randomUUID(), A, JSON.stringify({ status: 'active' }), '2026-08-12T12:00:00.000Z'],
  );
  await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
    await openOrRefreshAttentionItem(tx, {
      tenant_id: A,
      condition_key: 'owner.approval.pending',
      event_class: 'authority_permission_change',
      subject_ref: 'approval:1',
      owner_action_required: true,
      severity: 'HIGH',
      evidence_refs: ['evidence:approval:1'],
    });
  });
});

after(async () => { await db.close(); });

describe('V1.0B Agent 0 T0/T1', () => {
  test('autonomy flags: T0/T1 read enabled, business writes disabled', () => {
    assert.equal(AGENT0_T0_T1_READ, true);
    assert.equal(BUSINESS_WRITE_AUTONOMY, false);
  });

  test('T0 observe returns evidence-backed read state only', async () => {
    const observation = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      observeTenant(
        { tx: async (fn) => fn(tx), query: (t, p) => tx.query(t, p) },
        { tenant_id: A, context_envelope: contextFor(A) },
      ),
    );
    assert.equal(observation.autonomy_level, 'T0');
    assert.ok(observation.state_records.length >= 1);
    assert.ok(observation.open_attention_items.length >= 1);
    assert.equal(observation.business_write_autonomy, false);
  });

  test('T1 recommend/draft produces recommendations without writes', async () => {
    const observation = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      observeTenant(
        { tx: async (fn) => fn(tx), query: (t, p) => tx.query(t, p) },
        { tenant_id: A, context_envelope: contextFor(A) },
      ),
    );
    const before = await db.query('SELECT count(*)::int AS n FROM attention_items;');
    const rec = recommendDraft({
      observation,
      context_envelope: contextFor(A),
      routine_id: 'agent0.read_safe',
    });
    const after = await db.query('SELECT count(*)::int AS n FROM attention_items;');
    assert.equal(rec.autonomy_level, 'T1');
    assert.ok(rec.recommendations.length >= 1);
    assert.match(rec.draft.body, /owner action|stale|continue observe/i);
    assert.equal(before.rows[0].n, after.rows[0].n, 'T1 must not mutate durable state');
  });

  test('third-party tenant is blocked from portfolio synthesis', async () => {
    await assert.rejects(
      () => synthesizeFirstPartyPortfolio(db, {
        context_envelope: {
          ...contextFor(B, { confidentiality_class: 'THIRD_PARTY_ISOLATED' }),
          authorized_tenant_ids: [B],
          context_source: 'portfolio',
          active_tenant_id: null,
        },
        authorized_tenant_ids: [B],
      }),
      (err) => err instanceof Agent0Error && err.code === 'PORTFOLIO_ISOLATION',
    );
  });

  test('Jarvis owner briefing uses Changed/Needs You/Risks sections', async () => {
    const briefing = await buildOwnerBriefing(db, {
      context_envelope: contextFor(A),
      authorized_tenant_ids: [A],
    });
    assert.ok(briefing.briefing_id);
    assert.ok(briefing.sections.changed.length >= 1);
    assert.ok(briefing.sections.needs_you.length >= 1);
    assert.ok(briefing.sections.risks_unknowns.length >= 1);
    assert.equal(briefing.business_write_autonomy, false);
    assert.equal(briefing.content_trust, 'TRUSTED_STRUCTURED');
  });

  test('first-party portfolio synthesis stays read-only', async () => {
    const portfolio = await synthesizeFirstPartyPortfolio(db, {
      context_envelope: {
        ...contextFor(A),
        authorized_tenant_ids: [A],
        context_source: 'portfolio',
        active_tenant_id: null,
        cross_tenant: false,
      },
      authorized_tenant_ids: [A],
    });
    assert.equal(portfolio.tenants.length, 1);
    assert.equal(portfolio.tenants[0].confidentiality_class, 'FIRST_PARTY_PORTFOLIO');
    assert.ok(portfolio.tenants[0].observation_summary.state_count >= 1);
  });
});
