// src/contracts/ids.js
// Deterministic canonical IDs + request_hash helpers per 06_SYSTEM_CONTRACTS.md.

import { createHash, randomUUID } from 'node:crypto';

export function newUuid() {
  return randomUUID();
}

// Canonical, stable hash of a canonical_request object. Deterministic JSON
// serialization (sorted keys) so the same logical request yields the same hash
// across process restart, matching the deterministic idempotency requirement.
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// request_hash = SHA256(canonical_json(canonical_request))
export function requestHash(canonicalRequest) {
  return sha256Hex(canonicalJson(canonicalRequest));
}

// Deterministic idempotency key per 06:
//   SHA256(tenant_id || workflow_id || step_id || capability_id || request_hash)
// Stable across process restart / re-instantiation.
export function idempotencyKey({ tenant_id, workflow_id, step_id, capability_id, request_hash }) {
  const parts = [
    String(tenant_id),
    String(workflow_id),
    String(step_id),
    String(capability_id),
    String(request_hash),
  ];
  return sha256Hex(parts.join(''));
}
