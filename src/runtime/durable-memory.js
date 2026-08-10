// src/runtime/durable-memory.js
// F-11 global durable memory gate for acceptance #44:
//   "Third-party tenant data never becomes global raw durable memory."
//
// Per 01_ARCHITECTURE_LOCKS.md confidentiality model:
//   THIRD_PARTY_ISOLATED tenants do not contribute raw data to global durable
//   memory; they may contribute only explicitly permitted, de-identified
//   aggregate operational metadata.
// Raw tenant context is not persisted globally.

import { randomUUID } from 'node:crypto';

export const GLOBAL_MEMORY_CLASSES = Object.freeze([
  'DEIDENTIFIED_AGGREGATE',
  'OPERATIONAL_METADATA',
]);

export const CONFIDENTIALITY_CLASSES = Object.freeze([
  'FIRST_PARTY_PORTFOLIO',
  'THIRD_PARTY_ISOLATED',
]);

export class DurableMemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DurableMemoryError';
    this.code = code;
  }
}

function looksLikeRawTenantPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true;
  if (payload.raw_tenant_data === true || payload.raw_tenant_data === 'true') return true;
  if (payload.raw === true) return true;
  // Connector read results marked as raw copies of tenant provider data.
  if (payload.kind === 'raw_connector_read') return true;
  if (payload.pii_raw != null) return true;
  if (typeof payload.customer_email === 'string') return true;
  if (typeof payload.customer_phone === 'string') return true;
  if (typeof payload.full_name === 'string') return true;
  return false;
}

/**
 * Decide whether a connector/read result may enter global durable memory.
 * Fail closed for third-party raw data.
 */
export function classifyGlobalMemoryIngest({
  source_confidentiality_class,
  payload,
  memory_class,
}) {
  if (!CONFIDENTIALITY_CLASSES.includes(source_confidentiality_class)) {
    return {
      allowed: false,
      code: 'UNKNOWN_CONFIDENTIALITY_CLASS',
      reason: `unknown confidentiality class: ${source_confidentiality_class}`,
    };
  }
  if (!GLOBAL_MEMORY_CLASSES.includes(memory_class)) {
    return {
      allowed: false,
      code: 'INVALID_MEMORY_CLASS',
      reason: `memory_class must be one of ${GLOBAL_MEMORY_CLASSES.join('|')}`,
    };
  }
  if (looksLikeRawTenantPayload(payload)) {
    return {
      allowed: false,
      code: 'RAW_TENANT_DATA_FORBIDDEN',
      reason: 'raw tenant data cannot enter global durable memory',
    };
  }
  if (source_confidentiality_class === 'THIRD_PARTY_ISOLATED') {
    // Only explicitly permitted de-identified aggregates / operational metadata.
    if (
      memory_class !== 'DEIDENTIFIED_AGGREGATE' &&
      memory_class !== 'OPERATIONAL_METADATA'
    ) {
      return {
        allowed: false,
        code: 'THIRD_PARTY_RAW_FORBIDDEN',
        reason: 'third-party tenant data never becomes global raw durable memory',
      };
    }
    if (payload?.permitted !== true) {
      return {
        allowed: false,
        code: 'THIRD_PARTY_NOT_PERMITTED',
        reason: 'third-party global memory requires explicit permitted=true aggregate',
      };
    }
    if (payload?.deidentified !== true && memory_class === 'DEIDENTIFIED_AGGREGATE') {
      return {
        allowed: false,
        code: 'THIRD_PARTY_NOT_DEIDENTIFIED',
        reason: 'third-party aggregate must be deidentified=true',
      };
    }
  }
  return { allowed: true, code: null, reason: null };
}

/**
 * Persist to global_durable_memory only after the #44 policy gate passes.
 * Caller may be inside any role that has INSERT; the gate is the authority.
 */
export async function ingestGlobalDurableMemory(backend, {
  source_confidentiality_class,
  source_tenant_id = null,
  memory_class,
  payload,
}) {
  const decision = classifyGlobalMemoryIngest({
    source_confidentiality_class,
    payload,
    memory_class,
  });
  if (!decision.allowed) {
    throw new DurableMemoryError(decision.code, decision.reason);
  }

  const memory_id = randomUUID();
  await backend.query(
    `INSERT INTO global_durable_memory (
       memory_id, memory_class, source_confidentiality_class,
       source_tenant_id, payload
     ) VALUES ($1, $2, $3, $4, $5::jsonb);`,
    [
      memory_id,
      memory_class,
      source_confidentiality_class,
      source_tenant_id,
      JSON.stringify(payload),
    ]
  );
  return { memory_id, memory_class, source_confidentiality_class, ingested: true };
}

/**
 * After a read-only connector fetch: refuse to promote third-party raw results
 * into global durable memory. Returns a typed refusal or permitted ingest.
 */
export async function promoteConnectorReadToGlobalMemory(backend, {
  tenant_confidentiality_class,
  tenant_id,
  connector_read_result,
  memory_class = 'DEIDENTIFIED_AGGREGATE',
  aggregate_payload = null,
}) {
  // Raw connector reads are never globalized.
  if (connector_read_result?.data != null && aggregate_payload == null) {
    const decision = classifyGlobalMemoryIngest({
      source_confidentiality_class: tenant_confidentiality_class,
      memory_class,
      payload: {
        kind: 'raw_connector_read',
        raw_tenant_data: true,
        data: connector_read_result.data,
      },
    });
    if (!decision.allowed) {
      throw new DurableMemoryError(decision.code, decision.reason);
    }
  }

  if (aggregate_payload == null) {
    throw new DurableMemoryError(
      'AGGREGATE_REQUIRED',
      'global memory requires an explicit permitted aggregate payload'
    );
  }

  return ingestGlobalDurableMemory(backend, {
    source_confidentiality_class: tenant_confidentiality_class,
    source_tenant_id: tenant_id,
    memory_class,
    payload: aggregate_payload,
  });
}
