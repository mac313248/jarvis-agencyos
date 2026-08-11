// src/runtime/pii-erasure.js
// F-14 Security / privacy acceptance (#40, #41, #43).
//
// Per 07_AUTHORITY_SECURITY_EXECUTION.md#PII-erasure and
// 05_PRODUCT_BEHAVIOR.md#Deletion-behavior:
//   Valid customer deletion removes identifiable canonical data and withdraws
//   vectors/FTS/cache/derived summaries that expose the subject.
//   Only non-identifying audit proof (opaque subject_ref + tombstone) remains.
//
// Stop conditions:
//   - deletion leaves PII in vectors/FTS/cache
//   - no audit tombstone
//
// NON-SCOPE: business writes. Autonomy remains DISABLED.

import { randomUUID } from 'node:crypto';
import { asRole } from '../db/index.js';
import {
  assertBusinessWriteAutonomyDisabled,
  BUSINESS_WRITE_AUTONOMY,
} from './autonomy.js';

export const PII_ERASURE_SURFACES = Object.freeze([
  'pii_store',
  'embeddings',
  'fts',
  'cache',
  'derived_summaries',
  'current_state',
]);

export class PiiErasureError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PiiErasureError';
    this.code = code;
    this.details = details;
  }
}

function requireTrustedTenant(trustedTenantId) {
  if (!trustedTenantId) {
    throw new PiiErasureError(
      'MISSING_TENANT_CONTEXT',
      'trustedTenantId required for customer deletion (fail-closed)'
    );
  }
}

function requireSubjectRef(subjectRef) {
  if (!subjectRef) {
    throw new PiiErasureError(
      'MISSING_SUBJECT_REF',
      'subjectRef required for customer deletion (fail-closed)'
    );
  }
}

/**
 * Seed canonical + derived surfaces that can expose customer PII.
 * Test/fixture helper used by the acceptance suite; not a business write.
 */
export async function seedCustomerPiiSurfaces(db, {
  trustedTenantId,
  subjectRef,
  pii,
  piiStoreRef = null,
}) {
  assertBusinessWriteAutonomyDisabled();
  requireTrustedTenant(trustedTenantId);
  requireSubjectRef(subjectRef);
  if (!pii || typeof pii !== 'object') {
    throw new PiiErasureError('INVALID_PII', 'pii object required');
  }

  const storeRef = piiStoreRef || `pii-store://${subjectRef}`;
  const piiRowId = randomUUID();
  const embeddingId = randomUUID();
  const ftsId = randomUUID();
  const cacheId = randomUUID();
  const summaryId = randomUUID();
  const stateId = randomUUID();

  return asRole(db, 'app_runtime', async (backend) => {
    return backend.tx(async (tx) => {
      await tx.query('SELECT set_tenant($1);', [trustedTenantId]);

      await tx.query(
        `INSERT INTO pii_subjects (subject_ref, tenant_id, pii_store_ref, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (subject_ref) DO UPDATE
           SET pii_store_ref = EXCLUDED.pii_store_ref,
               status = 'active',
               deleted_at = NULL;`,
        [subjectRef, trustedTenantId, storeRef]
      );

      await tx.query(
        `INSERT INTO pii_store_rows
           (pii_row_id, tenant_id, subject_ref, email, full_name, phone)
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [
          piiRowId,
          trustedTenantId,
          subjectRef,
          pii.email ?? null,
          pii.full_name ?? null,
          pii.phone ?? null,
        ]
      );

      const content = [
        pii.full_name,
        pii.email,
        pii.phone,
      ].filter(Boolean).join(' | ');

      await tx.query(
        `INSERT INTO subject_embeddings
           (embedding_id, tenant_id, subject_ref, source_record_ref, content_text, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb);`,
        [
          embeddingId,
          trustedTenantId,
          subjectRef,
          `pii_store_rows:${piiRowId}`,
          content,
          JSON.stringify([0.1, 0.2, 0.3]),
        ]
      );

      await tx.query(
        `INSERT INTO subject_fts_documents
           (fts_id, tenant_id, subject_ref, source_record_ref, document_text)
         VALUES ($1, $2, $3, $4, $5);`,
        [
          ftsId,
          trustedTenantId,
          subjectRef,
          `pii_store_rows:${piiRowId}`,
          `customer profile ${content}`,
        ]
      );

      await tx.query(
        `INSERT INTO subject_cache_entries
           (cache_id, tenant_id, subject_ref, cache_key, cache_value)
         VALUES ($1, $2, $3, $4, $5::jsonb);`,
        [
          cacheId,
          trustedTenantId,
          subjectRef,
          `subject:${subjectRef}:profile`,
          JSON.stringify({
            email: pii.email ?? null,
            full_name: pii.full_name ?? null,
            phone: pii.phone ?? null,
          }),
        ]
      );

      await tx.query(
        `INSERT INTO subject_derived_summaries
           (summary_id, tenant_id, subject_ref, source_record_ref, summary_text)
         VALUES ($1, $2, $3, $4, $5);`,
        [
          summaryId,
          trustedTenantId,
          subjectRef,
          `pii_store_rows:${piiRowId}`,
          `Summary for ${pii.full_name || 'customer'} <${pii.email || 'unknown'}>`,
        ]
      );

      await tx.query(
        `INSERT INTO current_state_records
           (state_id, tenant_id, state_key, domain, subject_ref, value, state_version,
            source_system, max_age_seconds, freshness)
         VALUES ($1, $2, $3, 'customer_profile', $4, $5::jsonb, 'v1',
                 'pii-erasure-fixture', 3600, 'FRESH');`,
        [
          stateId,
          trustedTenantId,
          `customer:${subjectRef}`,
          String(subjectRef),
          JSON.stringify({
            email: pii.email ?? null,
            full_name: pii.full_name ?? null,
            phone: pii.phone ?? null,
          }),
        ]
      );

      return {
        subject_ref: subjectRef,
        pii_store_ref: storeRef,
        pii_row_id: piiRowId,
        embedding_id: embeddingId,
        fts_id: ftsId,
        cache_id: cacheId,
        summary_id: summaryId,
        state_id: stateId,
      };
    });
  });
}

/**
 * Valid customer deletion: withdraw identifiable canonical + derived surfaces
 * and leave a non-identifying audit tombstone.
 */
export async function executeCustomerDeletion(db, {
  trustedTenantId,
  subjectRef,
  requestRef = null,
}) {
  assertBusinessWriteAutonomyDisabled();
  requireTrustedTenant(trustedTenantId);
  requireSubjectRef(subjectRef);

  if (BUSINESS_WRITE_AUTONOMY !== false) {
    throw new PiiErasureError(
      'BUSINESS_WRITE_AUTONOMY_ENABLED',
      'customer deletion path refuses enabled business-write autonomy'
    );
  }

  const opaqueRequestRef = requestRef || `delreq:${randomUUID()}`;

  return asRole(db, 'app_runtime', async (backend) => {
    return backend.tx(async (tx) => {
      await tx.query('SELECT set_tenant($1);', [trustedTenantId]);

      const subject = await tx.query(
        `SELECT subject_ref, status, pii_store_ref
           FROM pii_subjects
          WHERE subject_ref = $1;`,
        [subjectRef]
      );
      if (subject.rows.length === 0) {
        throw new PiiErasureError(
          'SUBJECT_NOT_FOUND',
          `pii subject ${subjectRef} not found in tenant`
        );
      }
      if (subject.rows[0].status === 'legal_hold') {
        throw new PiiErasureError(
          'LEGAL_HOLD',
          'customer deletion blocked by legal_hold'
        );
      }

      // Idempotent re-delete: ensure tombstone exists, do not recreate PII.
      if (subject.rows[0].status === 'deleted') {
        const existing = await tx.query(
          `SELECT tombstone_id, subject_ref, request_ref, surfaces_withdrawn, deleted_at
             FROM deletion_audit_tombstones
            WHERE subject_ref = $1
            ORDER BY deleted_at DESC
            LIMIT 1;`,
          [subjectRef]
        );
        if (existing.rows.length === 0) {
          throw new PiiErasureError(
            'TOMBSTONE_MISSING',
            'deleted subject has no audit tombstone (stop condition)'
          );
        }
        return {
          status: 'already_deleted',
          subject_ref: subjectRef,
          tombstone_id: existing.rows[0].tombstone_id,
          request_ref: existing.rows[0].request_ref,
          surfaces_withdrawn: existing.rows[0].surfaces_withdrawn,
          deleted_at: existing.rows[0].deleted_at,
        };
      }

      const surfaces = {};

      const piiDel = await tx.query(
        `DELETE FROM pii_store_rows WHERE subject_ref = $1 RETURNING pii_row_id;`,
        [subjectRef]
      );
      surfaces.pii_store = piiDel.rows.length;

      const embDel = await tx.query(
        `DELETE FROM subject_embeddings WHERE subject_ref = $1 RETURNING embedding_id;`,
        [subjectRef]
      );
      surfaces.embeddings = embDel.rows.length;

      const ftsDel = await tx.query(
        `DELETE FROM subject_fts_documents WHERE subject_ref = $1 RETURNING fts_id;`,
        [subjectRef]
      );
      surfaces.fts = ftsDel.rows.length;

      const cacheDel = await tx.query(
        `DELETE FROM subject_cache_entries WHERE subject_ref = $1 RETURNING cache_id;`,
        [subjectRef]
      );
      surfaces.cache = cacheDel.rows.length;

      const sumDel = await tx.query(
        `DELETE FROM subject_derived_summaries WHERE subject_ref = $1 RETURNING summary_id;`,
        [subjectRef]
      );
      surfaces.derived_summaries = sumDel.rows.length;

      const stateDel = await tx.query(
        `DELETE FROM current_state_records WHERE subject_ref = $1 RETURNING state_id;`,
        [String(subjectRef)]
      );
      surfaces.current_state = stateDel.rows.length;

      await tx.query(
        `UPDATE pii_subjects
            SET status = 'deleted', deleted_at = now()
          WHERE subject_ref = $1;`,
        [subjectRef]
      );

      const tombstoneId = randomUUID();
      await tx.query(
        `INSERT INTO deletion_audit_tombstones
           (tombstone_id, tenant_id, subject_ref, request_ref, surfaces_withdrawn)
         VALUES ($1, $2, $3, $4, $5::jsonb);`,
        [
          tombstoneId,
          trustedTenantId,
          subjectRef,
          opaqueRequestRef,
          JSON.stringify(surfaces),
        ]
      );

      return {
        status: 'deleted',
        subject_ref: subjectRef,
        tombstone_id: tombstoneId,
        request_ref: opaqueRequestRef,
        surfaces_withdrawn: surfaces,
      };
    });
  });
}

/**
 * Fail closed: any remaining PII token in canonical/derived surfaces is a stop.
 */
export async function assertDeletedPiiNotExposed(db, {
  trustedTenantId,
  subjectRef,
  piiTokens,
}) {
  assertBusinessWriteAutonomyDisabled();
  requireTrustedTenant(trustedTenantId);
  requireSubjectRef(subjectRef);
  const tokens = (piiTokens || []).filter((t) => typeof t === 'string' && t.length > 0);
  if (tokens.length === 0) {
    throw new PiiErasureError('MISSING_PII_TOKENS', 'piiTokens required for exposure check');
  }

  return asRole(db, 'app_runtime', async (backend) => {
    return backend.tx(async (tx) => {
      await tx.query('SELECT set_tenant($1);', [trustedTenantId]);

      const exposures = [];

      const piiRows = await tx.query(
        `SELECT email, full_name, phone FROM pii_store_rows WHERE subject_ref = $1;`,
        [subjectRef]
      );
      for (const row of piiRows.rows) {
        for (const token of tokens) {
          for (const field of ['email', 'full_name', 'phone']) {
            if (row[field] && String(row[field]).includes(token)) {
              exposures.push({ surface: 'pii_store', field, token });
            }
          }
        }
      }

      const embeddings = await tx.query(
        `SELECT content_text FROM subject_embeddings WHERE subject_ref = $1;`,
        [subjectRef]
      );
      for (const row of embeddings.rows) {
        for (const token of tokens) {
          if (String(row.content_text).includes(token)) {
            exposures.push({ surface: 'embeddings', token });
          }
        }
      }

      const fts = await tx.query(
        `SELECT document_text FROM subject_fts_documents WHERE subject_ref = $1;`,
        [subjectRef]
      );
      for (const row of fts.rows) {
        for (const token of tokens) {
          if (String(row.document_text).includes(token)) {
            exposures.push({ surface: 'fts', token });
          }
        }
      }

      const cache = await tx.query(
        `SELECT cache_value::text AS blob FROM subject_cache_entries WHERE subject_ref = $1;`,
        [subjectRef]
      );
      for (const row of cache.rows) {
        for (const token of tokens) {
          if (String(row.blob).includes(token)) {
            exposures.push({ surface: 'cache', token });
          }
        }
      }

      const summaries = await tx.query(
        `SELECT summary_text FROM subject_derived_summaries WHERE subject_ref = $1;`,
        [subjectRef]
      );
      for (const row of summaries.rows) {
        for (const token of tokens) {
          if (String(row.summary_text).includes(token)) {
            exposures.push({ surface: 'derived_summaries', token });
          }
        }
      }

      const state = await tx.query(
        `SELECT value::text AS blob FROM current_state_records WHERE subject_ref = $1;`,
        [String(subjectRef)]
      );
      for (const row of state.rows) {
        for (const token of tokens) {
          if (String(row.blob).includes(token)) {
            exposures.push({ surface: 'current_state', token });
          }
        }
      }

      // Defense-in-depth: tokens must not remain on THIS subject_ref even if a
      // surface row lost expected linkage fields. Other active subjects may
      // legitimately retain their own distinct PII.
      for (const token of tokens) {
        const like = `%${token}%`;
        const leaked = await tx.query(
          `SELECT 'embeddings' AS surface, count(*)::int AS n FROM subject_embeddings
             WHERE subject_ref = $2 AND content_text LIKE $1
           UNION ALL
           SELECT 'fts', count(*)::int FROM subject_fts_documents
             WHERE subject_ref = $2 AND document_text LIKE $1
           UNION ALL
           SELECT 'cache', count(*)::int FROM subject_cache_entries
             WHERE subject_ref = $2 AND cache_value::text LIKE $1
           UNION ALL
           SELECT 'derived_summaries', count(*)::int FROM subject_derived_summaries
             WHERE subject_ref = $2 AND summary_text LIKE $1
           UNION ALL
           SELECT 'pii_store', count(*)::int FROM pii_store_rows
             WHERE subject_ref = $2 AND (
               coalesce(email,'') LIKE $1
               OR coalesce(full_name,'') LIKE $1
               OR coalesce(phone,'') LIKE $1
             )
           UNION ALL
           SELECT 'current_state', count(*)::int FROM current_state_records
             WHERE subject_ref = $3 AND value::text LIKE $1;`,
          [like, subjectRef, String(subjectRef)]
        );
        for (const row of leaked.rows) {
          if (row.n > 0) {
            exposures.push({ surface: row.surface, token, count: row.n });
          }
        }
      }

      if (exposures.length > 0) {
        throw new PiiErasureError(
          'PII_STILL_EXPOSED',
          'deletion left identifiable data in vectors/FTS/cache/derived surfaces',
          { exposures }
        );
      }

      return { ok: true, subject_ref: subjectRef, tokens_checked: tokens.length };
    });
  });
}

export function createPiiErasureRuntime(db, { trustedTenantId } = {}) {
  requireTrustedTenant(trustedTenantId);
  return {
    trustedTenantId,
    seedCustomerPiiSurfaces: (args) =>
      seedCustomerPiiSurfaces(db, { trustedTenantId, ...args }),
    executeCustomerDeletion: (args) =>
      executeCustomerDeletion(db, { trustedTenantId, ...args }),
    assertDeletedPiiNotExposed: (args) =>
      assertDeletedPiiNotExposed(db, { trustedTenantId, ...args }),
  };
}
