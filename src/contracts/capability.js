// src/contracts/capability.js
// Canonical Capability contract validation + persistence helpers per
// docs/master-sot/06_SYSTEM_CONTRACTS.md.
//
// credential_ref is an opaque reference only. Raw provider secrets must never
// appear in capability metadata, source, Git, prompts, evidence, traces, or tests.

export const CAPABILITY_CONTRACT_VERSION = 1;

export const CONTROL_SURFACES = Object.freeze([
  'api', 'mcp', 'cli', 'dom', 'browser_agent', 'computer_use', 'human',
]);
export const REVERSIBILITIES = Object.freeze([
  'reversible', 'compensatable', 'irreversible',
]);
export const PROVIDER_IDEMPOTENCY = Object.freeze([
  'supported', 'unsupported', 'unknown',
]);
export const CAPABILITY_STATUSES = Object.freeze([
  'active', 'degraded', 'disabled',
]);

// Forbidden raw-secret column / field names for capability metadata.
export const FORBIDDEN_SECRET_FIELDS = Object.freeze([
  'password', 'api_key', 'apikey', 'secret', 'token', 'access_token',
  'refresh_token', 'client_secret', 'private_key', 'bearer',
]);

export class CapabilityValidationError extends Error {
  constructor(reason) {
    super(`invalid capability: ${reason}`);
    this.name = 'CapabilityValidationError';
    this.reason = reason;
  }
}

function requireString(obj, key) {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new CapabilityValidationError(`${key} must be a non-empty string`);
  }
  return v;
}

function requireEnum(obj, key, allowed) {
  const v = requireString(obj, key);
  if (!allowed.includes(v)) {
    throw new CapabilityValidationError(`${key} must be one of ${allowed.join('|')}`);
  }
  return v;
}

function requireObject(obj, key) {
  const v = obj[key];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new CapabilityValidationError(`${key} must be an object`);
  }
  return v;
}

function requireStringArray(obj, key) {
  const v = obj[key];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
    throw new CapabilityValidationError(`${key} must be an array of strings`);
  }
  return v;
}

function assertNoRawSecretFields(obj) {
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_SECRET_FIELDS.includes(k.toLowerCase())) {
      throw new CapabilityValidationError(`raw credential-bearing field forbidden: ${k}`);
    }
  }
}

// Validate a Capability object against the canonical 06 contract (excluding
// the persistence-only tenant_id ownership key).
export function validateCapabilityContract(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CapabilityValidationError('capability must be an object');
  }
  assertNoRawSecretFields(input);

  const contract_version = input.contract_version ?? CAPABILITY_CONTRACT_VERSION;
  if (contract_version !== CAPABILITY_CONTRACT_VERSION) {
    throw new CapabilityValidationError(`contract_version must be ${CAPABILITY_CONTRACT_VERSION}`);
  }

  const capability_id = requireString(input, 'capability_id');
  const tenant_scope = requireString(input, 'tenant_scope');
  const provider = requireString(input, 'provider');
  const control_surface = requireEnum(input, 'control_surface', CONTROL_SURFACES);
  const adapter = requireString(input, 'adapter');
  const operation = requireString(input, 'operation');
  const risk_class = requireString(input, 'risk_class');
  const reversibility = requireEnum(input, 'reversibility', REVERSIBILITIES);
  const auth_scope = requireObject(input, 'auth_scope');
  const provider_idempotency = requireEnum(input, 'provider_idempotency', PROVIDER_IDEMPOTENCY);
  if (typeof input.postcondition_observable !== 'boolean') {
    throw new CapabilityValidationError('postcondition_observable must be boolean');
  }
  const preconditions = requireObject(input, 'preconditions');
  const postcondition_verifier =
    input.postcondition_verifier === null || input.postcondition_verifier === undefined
      ? null
      : requireString(input, 'postcondition_verifier');
  const fallback_routes = requireStringArray(input, 'fallback_routes');
  const approval_policy = requireString(input, 'approval_policy');
  const network_scope = requireObject(input, 'network_scope');
  const timeout_retry_policy = requireObject(input, 'timeout_retry_policy');
  const receipt_schema = requireString(input, 'receipt_schema');
  const status = requireEnum(input, 'status', CAPABILITY_STATUSES);

  let credential_ref = null;
  if (input.credential_ref !== null && input.credential_ref !== undefined) {
    if (typeof input.credential_ref !== 'string' || input.credential_ref.length === 0) {
      throw new CapabilityValidationError('credential_ref must be opaque_ref string or null');
    }
    // Opaque ref only: reject values that look like inline secrets.
    if (/^(sk-|Bearer |-----BEGIN )/i.test(input.credential_ref)) {
      throw new CapabilityValidationError('credential_ref must remain an opaque reference');
    }
    credential_ref = input.credential_ref;
  }

  return {
    contract_version,
    capability_id,
    tenant_scope,
    provider,
    control_surface,
    adapter,
    operation,
    risk_class,
    reversibility,
    auth_scope,
    credential_ref,
    provider_idempotency,
    postcondition_observable: input.postcondition_observable,
    preconditions,
    postcondition_verifier,
    fallback_routes,
    approval_policy,
    network_scope,
    timeout_retry_policy,
    receipt_schema,
    status,
  };
}

// SOT rule: If provider_idempotency != supported AND postcondition_observable=false:
// - autonomous retry/replay is forbidden after an ambiguous outcome;
// - the action is at least APPROVAL_REQUIRED;
// - ambiguous completion escalates to human/blocked.
export function classifyAmbiguousOutcomePolicy(capability) {
  const cap = validateCapabilityContract(capability);
  const unsafe =
    cap.provider_idempotency !== 'supported' &&
    cap.postcondition_observable === false;

  if (unsafe) {
    return {
      autonomously_retryable_after_ambiguity: false,
      min_verdict: 'APPROVAL_REQUIRED',
      ambiguous_completion: 'human_or_blocked',
      reason_codes: [
        'PROVIDER_IDEMPOTENCY_NOT_SUPPORTED_OR_UNKNOWN',
        'POSTCONDITION_NOT_OBSERVABLE',
        'AUTONOMOUS_RETRY_FORBIDDEN_AFTER_AMBIGUITY',
      ],
    };
  }

  return {
    autonomously_retryable_after_ambiguity: cap.provider_idempotency === 'supported',
    min_verdict: null,
    ambiguous_completion: 'policy_dependent',
    reason_codes: [],
  };
}

// Persist a validated capability under the trusted transaction-local tenant.
// Caller MUST already be inside a tenant-scoped runtime transaction.
// tenant_id is taken EXCLUSIVELY from cur_tenant() — never from caller args.
export async function insertCapability(backend, capabilityInput) {
  const cap = validateCapabilityContract(capabilityInput);
  const tenantRes = await backend.query('SELECT require_tenant() AS tenant_id;');
  const tenantId = tenantRes.rows[0].tenant_id;

  await backend.query(
    `INSERT INTO capabilities (
       tenant_id, capability_id, contract_version, tenant_scope, provider,
       control_surface, adapter, operation, risk_class, reversibility,
       auth_scope, credential_ref, provider_idempotency, postcondition_observable,
       preconditions, postcondition_verifier, fallback_routes, approval_policy,
       network_scope, timeout_retry_policy, receipt_schema, status
     ) VALUES (
       $1,$2,$3,$4,$5,
       $6,$7,$8,$9,$10,
       $11::jsonb,$12,$13,$14,
       $15::jsonb,$16,$17::jsonb,$18,
       $19::jsonb,$20::jsonb,$21,$22
     );`,
    [
      tenantId,
      cap.capability_id,
      cap.contract_version,
      cap.tenant_scope,
      cap.provider,
      cap.control_surface,
      cap.adapter,
      cap.operation,
      cap.risk_class,
      cap.reversibility,
      JSON.stringify(cap.auth_scope),
      cap.credential_ref,
      cap.provider_idempotency,
      cap.postcondition_observable,
      JSON.stringify(cap.preconditions),
      cap.postcondition_verifier,
      JSON.stringify(cap.fallback_routes),
      cap.approval_policy,
      JSON.stringify(cap.network_scope),
      JSON.stringify(cap.timeout_retry_policy),
      cap.receipt_schema,
      cap.status,
    ]
  );

  // Materialize same-tenant fallback FK refs when targets already exist.
  for (const fb of cap.fallback_routes) {
    await backend.query(
      `INSERT INTO capability_fallback_refs (tenant_id, capability_id, fallback_capability_id)
       SELECT $1, $2, $3
       WHERE EXISTS (
         SELECT 1 FROM capabilities c
         WHERE c.tenant_id = $1 AND c.capability_id = $3
       )
       ON CONFLICT DO NOTHING;`,
      [tenantId, cap.capability_id, fb]
    );
  }

  return { tenant_id: tenantId, ...cap };
}

export async function syncFallbackRefs(backend, capabilityId, fallbackRoutes) {
  const tenantRes = await backend.query('SELECT require_tenant() AS tenant_id;');
  const tenantId = tenantRes.rows[0].tenant_id;
  await backend.query(
    `DELETE FROM capability_fallback_refs
     WHERE tenant_id = $1 AND capability_id = $2;`,
    [tenantId, capabilityId]
  );
  for (const fb of fallbackRoutes) {
    await backend.query(
      `INSERT INTO capability_fallback_refs (tenant_id, capability_id, fallback_capability_id)
       VALUES ($1, $2, $3);`,
      [tenantId, capabilityId, fb]
    );
  }
}
