// tests/security-privacy-acceptance.test.mjs
// F-14 Security / privacy acceptance suite:
//   #40 valid customer deletion removes identifiable canonical data
//   #41 embeddings/FTS/cache/derived summaries no longer expose deleted PII
//   #43 non-identifying audit tombstone remains
//
// SOT: 12_ACCEPTANCE_AND_IMPLEMENTATION.md#Privacy-deletion
//      07_AUTHORITY_SECURITY_EXECUTION.md#PII-erasure
//      06_SYSTEM_CONTRACTS.md PII subject reference
//
// Stop conditions:
//   - deletion leaves PII in vectors/FTS/cache
//   - no audit tombstone
// Business-write autonomy remains DISABLED.
// Scope also covers third-party isolation regression (#44 already in F-11).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import {
  BUSINESS_WRITE_AUTONOMY,
  LIVE_EXTERNAL_SIDE_EFFECTS,
  SECURITY_PRIVACY_ACCEPTANCE,
  assertBusinessWriteAutonomyDisabled,
} from '../src/runtime/autonomy.js';
import {
  PII_ERASURE_SURFACES,
  PiiErasureError,
  createPiiErasureRuntime,
  executeCustomerDeletion,
  assertDeletedPiiNotExposed,
} from '../src/runtime/pii-erasure.js';
import {
  classifyGlobalMemoryIngest,
  DurableMemoryError,
  promoteConnectorReadToGlobalMemory,
} from '../src/runtime/durable-memory.js';

let db;
let harnessReady = false;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

const FIXTURE_PII = Object.freeze({
  email: 'ada.customer@example.test',
  full_name: 'Ada Customer',
  phone: '+1-555-0142',
});

before(async () => {
  db = await freshCluster({ unique: 'security-privacy-acceptance' });
  await seedTwoTenants(db, { aId: A, bId: B });
  harnessReady = true;
});

after(async () => {
  if (db) await db.close();
});

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function runtimeFor(tenantId) {
  return createPiiErasureRuntime(db, { trustedTenantId: tenantId });
}

async function insertOpaqueReceipt(tx, { tenantId, subjectRef }) {
  const traceId = randomUUID();
  const receiptId = randomUUID();
  await tx.query(
    `INSERT INTO execution_traces (trace_id, tenant_id, root_span)
     VALUES ($1, $2, 'f14-privacy');`,
    [traceId, tenantId]
  );
  await tx.query(
    `INSERT INTO execution_receipts
       (receipt_id, tenant_id, workflow_id, step_id, actor, capability_id, provider,
        operation, target_ref, subject_ref, idempotency_key, request_hash,
        revocation_epoch_at_commit, kill_epoch_at_commit, started_at, committed_at,
        verification_status, trace_id)
     VALUES ($1,$2,$3,'step-1','agent0','cap.read','local_fake','profile.read','acct-1',$4,$5,$6,
             0,0, now(), now(), 'VERIFIED', $7);`,
    [
      receiptId,
      tenantId,
      randomUUID(),
      subjectRef,
      `idem-f14-${receiptId}`,
      sha256Hex(`receipt-${receiptId}`),
      traceId,
    ]
  );
  return { receiptId, traceId };
}

describe('F-14 autonomy + contract surface', () => {
  test('acceptance harness initialized (cancelled suite is not a pass)', () => {
    assert.equal(harnessReady, true);
    assert.ok(db, 'freshCluster must succeed before F-14 acceptance runs');
  });

  test('business-write autonomy remains DISABLED', () => {
    assert.equal(BUSINESS_WRITE_AUTONOMY, false);
    assert.equal(LIVE_EXTERNAL_SIDE_EFFECTS, false);
    assert.equal(SECURITY_PRIVACY_ACCEPTANCE, true);
    assert.equal(assertBusinessWriteAutonomyDisabled(), true);
  });

  test('contract_metadata records PiiErasureDeletion v1', async () => {
    const r = await db.query(
      `SELECT contract_name, contract_version, schema_path
         FROM contract_metadata WHERE contract_name='PiiErasureDeletion';`
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].contract_version, 1);
    assert.match(r.rows[0].schema_path, /PII-erasure/);
    assert.match(r.rows[0].schema_path, /Privacy-deletion/);
  });

  test('erasure surfaces cover canonical + vectors/FTS/cache/summaries', () => {
    for (const surface of [
      'pii_store',
      'embeddings',
      'fts',
      'cache',
      'derived_summaries',
      'current_state',
    ]) {
      assert.ok(PII_ERASURE_SURFACES.includes(surface), surface);
    }
  });

  test('deletion_audit_tombstones has no raw PII columns', async () => {
    const cols = await db.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'deletion_audit_tombstones'
         AND (
           column_name ILIKE '%email%'
           OR column_name ILIKE '%phone%'
           OR column_name ILIKE '%name%'
           OR column_name ILIKE '%pii%'
         );`);
    assert.equal(cols.rows.length, 0, 'tombstone must not define raw PII columns');
  });
});

describe('Master #40 valid customer deletion removes identifiable canonical data', () => {
  test('#40 deletes pii_store + current_state for the subject', async () => {
    const subjectRef = randomUUID();
    const rt = runtimeFor(A);
    await rt.seedCustomerPiiSurfaces({ subjectRef, pii: FIXTURE_PII });

    const beforeStore = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT count(*)::int n FROM pii_store_rows WHERE subject_ref=$1;',
        [subjectRef]
      )).rows[0].n
    );
    const beforeState = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT count(*)::int n FROM current_state_records WHERE subject_ref=$1;',
        [String(subjectRef)]
      )).rows[0].n
    );
    assert.equal(beforeStore, 1);
    assert.equal(beforeState, 1);

    const result = await rt.executeCustomerDeletion({
      subjectRef,
      requestRef: `delreq-${subjectRef}`,
    });
    assert.equal(result.status, 'deleted');
    assert.equal(result.surfaces_withdrawn.pii_store, 1);
    assert.equal(result.surfaces_withdrawn.current_state, 1);

    const afterStore = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT count(*)::int n FROM pii_store_rows WHERE subject_ref=$1;',
        [subjectRef]
      )).rows[0].n
    );
    const afterState = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT count(*)::int n FROM current_state_records WHERE subject_ref=$1;',
        [String(subjectRef)]
      )).rows[0].n
    );
    const status = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT status, deleted_at IS NOT NULL AS has_deleted_at FROM pii_subjects WHERE subject_ref=$1;',
        [subjectRef]
      )).rows[0]
    );

    assert.equal(afterStore, 0, 'canonical identifiable pii_store rows must be gone');
    assert.equal(afterState, 0, 'identifiable current_state must be gone');
    assert.equal(status.status, 'deleted');
    assert.equal(status.has_deleted_at, true);
  });

  test('#40 legal_hold blocks deletion and leaves canonical PII', async () => {
    const subjectRef = randomUUID();
    const rt = runtimeFor(A);
    await rt.seedCustomerPiiSurfaces({ subjectRef, pii: FIXTURE_PII });
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query(
        `UPDATE pii_subjects SET status='legal_hold' WHERE subject_ref=$1;`,
        [subjectRef]
      );
    });

    await assert.rejects(
      () => rt.executeCustomerDeletion({ subjectRef }),
      (err) => {
        assert.ok(err instanceof PiiErasureError);
        assert.equal(err.code, 'LEGAL_HOLD');
        return true;
      }
    );

    const remaining = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        'SELECT count(*)::int n FROM pii_store_rows WHERE subject_ref=$1;',
        [subjectRef]
      )).rows[0].n
    );
    assert.equal(remaining, 1);
  });

  test('#40 fail-closed without trusted tenant context', async () => {
    await assert.rejects(
      () => executeCustomerDeletion(db, { subjectRef: randomUUID() }),
      (err) => {
        assert.ok(err instanceof PiiErasureError);
        assert.equal(err.code, 'MISSING_TENANT_CONTEXT');
        return true;
      }
    );
  });
});

describe('Master #41 embeddings/FTS/cache/derived summaries no longer expose deleted PII', () => {
  test('#41 withdraws all derived surfaces and exposure check passes', async () => {
    const subjectRef = randomUUID();
    const otherSubject = randomUUID();
    const rt = runtimeFor(A);
    const deletedPii = {
      email: `erase.${subjectRef.slice(0, 8)}@example.test`,
      full_name: `Erase Target ${subjectRef.slice(0, 8)}`,
      phone: '+1-555-0411',
    };
    const otherPii = {
      email: `keep.${otherSubject.slice(0, 8)}@example.test`,
      full_name: `Keep Other ${otherSubject.slice(0, 8)}`,
      phone: '+1-555-0199',
    };

    await rt.seedCustomerPiiSurfaces({ subjectRef, pii: deletedPii });
    await rt.seedCustomerPiiSurfaces({ subjectRef: otherSubject, pii: otherPii });

    const before = await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const emb = (await tx.query(
        'SELECT count(*)::int n FROM subject_embeddings WHERE subject_ref=$1;',
        [subjectRef]
      )).rows[0].n;
      const fts = (await tx.query(
        'SELECT count(*)::int n FROM subject_fts_documents WHERE subject_ref=$1;',
        [subjectRef]
      )).rows[0].n;
      const cache = (await tx.query(
        'SELECT count(*)::int n FROM subject_cache_entries WHERE subject_ref=$1;',
        [subjectRef]
      )).rows[0].n;
      const sum = (await tx.query(
        'SELECT count(*)::int n FROM subject_derived_summaries WHERE subject_ref=$1;',
        [subjectRef]
      )).rows[0].n;
      return { emb, fts, cache, sum };
    });
    assert.deepEqual(before, { emb: 1, fts: 1, cache: 1, sum: 1 });

    const result = await rt.executeCustomerDeletion({
      subjectRef,
      requestRef: `delreq-derived-${subjectRef}`,
    });
    assert.equal(result.surfaces_withdrawn.embeddings, 1);
    assert.equal(result.surfaces_withdrawn.fts, 1);
    assert.equal(result.surfaces_withdrawn.cache, 1);
    assert.equal(result.surfaces_withdrawn.derived_summaries, 1);

    const check = await rt.assertDeletedPiiNotExposed({
      subjectRef,
      piiTokens: [deletedPii.email, deletedPii.full_name, deletedPii.phone],
    });
    assert.equal(check.ok, true);

    // Other subject's PII must remain (no collateral deletion).
    const otherRemains = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        `SELECT
           (SELECT count(*)::int FROM pii_store_rows WHERE subject_ref=$1) AS store,
           (SELECT count(*)::int FROM subject_embeddings WHERE subject_ref=$1) AS emb,
           (SELECT count(*)::int FROM subject_fts_documents WHERE subject_ref=$1) AS fts,
           (SELECT count(*)::int FROM subject_cache_entries WHERE subject_ref=$1) AS cache,
           (SELECT count(*)::int FROM subject_derived_summaries WHERE subject_ref=$1) AS sum;`,
        [otherSubject]
      )).rows[0]
    );
    assert.deepEqual(otherRemains, { store: 1, emb: 1, fts: 1, cache: 1, sum: 1 });
  });

  test('#41 stop condition: leftover PII in embeddings fails closed', async () => {
    const subjectRef = randomUUID();
    const rt = runtimeFor(A);
    await rt.seedCustomerPiiSurfaces({ subjectRef, pii: FIXTURE_PII });
    await rt.executeCustomerDeletion({
      subjectRef,
      requestRef: `delreq-stop-${subjectRef}`,
    });

    // Simulate incomplete erasure: re-insert embedding with deleted PII.
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query(
        `INSERT INTO subject_embeddings
           (embedding_id, tenant_id, subject_ref, source_record_ref, content_text, embedding)
         VALUES ($1, $2, $3, 'leak', $4, '[]'::jsonb);`,
        [randomUUID(), A, subjectRef, `leaked ${FIXTURE_PII.email}`]
      );
    });

    await assert.rejects(
      () =>
        assertDeletedPiiNotExposed(db, {
          trustedTenantId: A,
          subjectRef,
          piiTokens: [FIXTURE_PII.email],
        }),
      (err) => {
        assert.ok(err instanceof PiiErasureError);
        assert.equal(err.code, 'PII_STILL_EXPOSED');
        return true;
      }
    );
  });
});

describe('Master #43 non-identifying audit tombstone remains', () => {
  test('#43 tombstone + opaque receipt remain after deletion', async () => {
    const subjectRef = randomUUID();
    const rt = runtimeFor(A);
    await rt.seedCustomerPiiSurfaces({ subjectRef, pii: FIXTURE_PII });

    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await insertOpaqueReceipt(tx, { tenantId: A, subjectRef });
    });

    const result = await rt.executeCustomerDeletion({
      subjectRef,
      requestRef: `delreq-tomb-${subjectRef}`,
    });
    assert.ok(result.tombstone_id);

    const tombstone = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        `SELECT tombstone_id, subject_ref, request_ref, surfaces_withdrawn, deleted_at
           FROM deletion_audit_tombstones
          WHERE subject_ref = $1;`,
        [subjectRef]
      )).rows[0]
    );
    assert.ok(tombstone, 'audit tombstone must remain');
    assert.equal(tombstone.subject_ref, subjectRef);
    assert.equal(tombstone.request_ref, `delreq-tomb-${subjectRef}`);
    assert.ok(tombstone.deleted_at);
    assert.equal(tombstone.surfaces_withdrawn.pii_store, 1);

    const tombBlob = JSON.stringify(tombstone);
    assert.equal(tombBlob.includes(FIXTURE_PII.email), false);
    assert.equal(tombBlob.includes(FIXTURE_PII.full_name), false);
    assert.equal(tombBlob.includes(FIXTURE_PII.phone), false);

    const receipt = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query(
        `SELECT count(*)::int n FROM execution_receipts WHERE subject_ref=$1;`,
        [subjectRef]
      )).rows[0].n
    );
    assert.equal(receipt, 1, 'non-identifying receipt with opaque subject_ref remains');

    // Idempotent second deletion still yields tombstone (stop: no tombstone).
    const again = await rt.executeCustomerDeletion({ subjectRef });
    assert.equal(again.status, 'already_deleted');
    assert.ok(again.tombstone_id);
  });

  test('#43 stop condition: deleted subject without tombstone fails closed', async () => {
    const subjectRef = randomUUID();
    const rt = runtimeFor(A);
    await rt.seedCustomerPiiSurfaces({ subjectRef, pii: FIXTURE_PII });
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query(
        `UPDATE pii_subjects SET status='deleted', deleted_at=now() WHERE subject_ref=$1;`,
        [subjectRef]
      );
    });

    await assert.rejects(
      () => rt.executeCustomerDeletion({ subjectRef }),
      (err) => {
        assert.ok(err instanceof PiiErasureError);
        assert.equal(err.code, 'TOMBSTONE_MISSING');
        return true;
      }
    );
  });
});

describe('F-14 third-party isolation regression (scope)', () => {
  test('third-party raw payload cannot enter global durable memory', () => {
    const decision = classifyGlobalMemoryIngest({
      source_confidentiality_class: 'THIRD_PARTY_ISOLATED',
      memory_class: 'DEIDENTIFIED_AGGREGATE',
      payload: {
        kind: 'raw_connector_read',
        raw_tenant_data: true,
        customer_email: FIXTURE_PII.email,
      },
    });
    assert.equal(decision.allowed, false);
  });

  test('promoteConnectorReadToGlobalMemory refuses third-party raw read', async () => {
    await assert.rejects(
      () =>
        promoteConnectorReadToGlobalMemory(db, {
          tenant_confidentiality_class: 'THIRD_PARTY_ISOLATED',
          tenant_id: B,
          connector_read_result: { data: { email: FIXTURE_PII.email } },
        }),
      (err) => {
        assert.ok(err instanceof DurableMemoryError);
        return true;
      }
    );
  });

  test('tenant B cannot read tenant A tombstones or pii_store', async () => {
    const subjectRef = randomUUID();
    const rt = runtimeFor(A);
    await rt.seedCustomerPiiSurfaces({ subjectRef, pii: FIXTURE_PII });
    await rt.executeCustomerDeletion({
      subjectRef,
      requestRef: `delreq-iso-${subjectRef}`,
    });

    const cross = await asRuntimeTenant(db, 'app_runtime', B, async (tx) => {
      const tombs = (await tx.query(
        'SELECT count(*)::int n FROM deletion_audit_tombstones WHERE subject_ref=$1;',
        [subjectRef]
      )).rows[0].n;
      const store = (await tx.query(
        'SELECT count(*)::int n FROM pii_store_rows;'
      )).rows[0].n;
      const subjects = (await tx.query(
        'SELECT count(*)::int n FROM pii_subjects WHERE subject_ref=$1;',
        [subjectRef]
      )).rows[0].n;
      return { tombs, store, subjects };
    });
    assert.deepEqual(cross, { tombs: 0, store: 0, subjects: 0 });
  });
});
