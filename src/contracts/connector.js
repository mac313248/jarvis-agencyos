// src/contracts/connector.js
// F-11 Connector machine contract — implementation contract bound to
// docs/master-sot/06_SYSTEM_CONTRACTS.md#Capability and
// docs/master-sot/07_AUTHORITY_SECURITY_EXECUTION.md#Credential-architecture.
//
// Does NOT invent a competing schema in the SOT. Connector rows bind a
// tenant-scoped adapter instance to Capability control surfaces with an
// opaque credential_broker_ref. Writer connectors are DISABLED for F-11.
//
// Raw provider secrets must never appear in connector metadata, worker
// messages, source, Git, prompts, evidence, or traces.

import { CONTROL_SURFACES, FORBIDDEN_SECRET_FIELDS } from './capability.js';

export const CONNECTOR_CONTRACT_VERSION = 1;

/** F-11: only read_only is authorized. */
export const CONNECTOR_ACCESS_MODES = Object.freeze(['read_only']);

export const CONNECTOR_STATUSES = Object.freeze([
  'active', 'degraded', 'disabled',
]);

export { FORBIDDEN_SECRET_FIELDS, CONTROL_SURFACES };

export class ConnectorValidationError extends Error {
  constructor(reason) {
    super(`invalid connector: ${reason}`);
    this.name = 'ConnectorValidationError';
    this.reason = reason;
  }
}

function requireString(obj, key) {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ConnectorValidationError(`${key} must be a non-empty string`);
  }
  return v;
}

function requireEnum(obj, key, allowed) {
  const v = requireString(obj, key);
  if (!allowed.includes(v)) {
    throw new ConnectorValidationError(`${key} must be one of ${allowed.join('|')}`);
  }
  return v;
}

function requireObject(obj, key) {
  const v = obj[key];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new ConnectorValidationError(`${key} must be an object`);
  }
  return v;
}

function requireStringArray(obj, key) {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ConnectorValidationError(`${key} must be an array of strings`);
  }
  return v;
}

function assertNoRawSecretFields(obj) {
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_SECRET_FIELDS.includes(k.toLowerCase())) {
      throw new ConnectorValidationError(`raw credential-bearing field forbidden: ${k}`);
    }
  }
}

/**
 * Recursively reject secret-bearing keys and inline secret-shaped string values
 * at any depth (auth_scope / network_scope metadata must stay non-secret).
 */
export function assertNoRawSecretsDeep(value, path = '') {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoRawSecretsDeep(v, `${path}[${i}]`));
    return true;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const key = k.toLowerCase();
      const childPath = path ? `${path}.${k}` : k;
      if (FORBIDDEN_SECRET_FIELDS.includes(key)) {
        throw new ConnectorValidationError(
          `raw credential-bearing field forbidden: ${childPath}`
        );
      }
      assertNoRawSecretsDeep(v, childPath);
    }
    return true;
  }
  if (typeof value === 'string') {
    if (/^(sk-|Bearer |-----BEGIN )/i.test(value)) {
      throw new ConnectorValidationError(
        `raw secret value forbidden at ${path || '<root>'}`
      );
    }
  }
  return true;
}

function assertOpaqueRef(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConnectorValidationError(`${field} must be opaque_ref string or null`);
  }
  if (/^(sk-|Bearer |-----BEGIN )/i.test(value)) {
    throw new ConnectorValidationError(`${field} must remain an opaque reference`);
  }
  if (FORBIDDEN_SECRET_FIELDS.some((f) => value.toLowerCase().includes(f))) {
    throw new ConnectorValidationError(`${field} must remain an opaque reference`);
  }
  return value;
}

/**
 * Validate a Connector object against the F-11 implementation contract.
 * Persistence ownership key tenant_id is taken from trusted context only.
 */
export function validateConnectorContract(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConnectorValidationError('connector must be an object');
  }
  assertNoRawSecretFields(input);

  const contract_version = input.contract_version ?? CONNECTOR_CONTRACT_VERSION;
  if (contract_version !== CONNECTOR_CONTRACT_VERSION) {
    throw new ConnectorValidationError(`contract_version must be ${CONNECTOR_CONTRACT_VERSION}`);
  }

  const connector_id = requireString(input, 'connector_id');
  const provider = requireString(input, 'provider');
  const control_surface = requireEnum(input, 'control_surface', CONTROL_SURFACES);
  const adapter = requireString(input, 'adapter');
  const access_mode = requireEnum(input, 'access_mode', CONNECTOR_ACCESS_MODES);
  const capability_ids = requireStringArray(input, 'capability_ids');
  const auth_scope = requireObject(input, 'auth_scope');
  const network_scope = requireObject(input, 'network_scope');
  assertNoRawSecretsDeep(auth_scope, 'auth_scope');
  assertNoRawSecretsDeep(network_scope, 'network_scope');
  const status = requireEnum(input, 'status', CONNECTOR_STATUSES);

  const credential_broker_ref = assertOpaqueRef(
    input.credential_broker_ref,
    'credential_broker_ref'
  );
  const authenticity_verification_ref = assertOpaqueRef(
    input.authenticity_verification_ref,
    'authenticity_verification_ref'
  );

  return {
    contract_version,
    connector_id,
    provider,
    control_surface,
    adapter,
    access_mode,
    capability_ids,
    credential_broker_ref,
    authenticity_verification_ref,
    auth_scope,
    network_scope,
    status,
  };
}

/** Fail closed when a writer / non-read_only mode is requested. */
export function assertReadOnlyConnector(connector) {
  const mode = connector?.access_mode;
  if (mode !== 'read_only') {
    throw new ConnectorValidationError(
      `writer connector disabled: access_mode=${mode ?? 'missing'} (F-11 read-only only)`
    );
  }
  return true;
}

/**
 * Persist a validated read-only connector under trusted transaction-local tenant.
 * tenant_id is taken EXCLUSIVELY from cur_tenant() — never from caller args.
 */
export async function insertConnector(backend, connectorInput) {
  const conn = validateConnectorContract(connectorInput);
  assertReadOnlyConnector(conn);

  const tenantRes = await backend.query('SELECT require_tenant() AS tenant_id;');
  const tenantId = tenantRes.rows[0].tenant_id;

  await backend.query(
    `INSERT INTO connectors (
       tenant_id, connector_id, contract_version, provider, control_surface,
       adapter, access_mode, capability_ids, credential_broker_ref,
       authenticity_verification_ref, auth_scope, network_scope, status
     ) VALUES (
       $1,$2,$3,$4,$5,
       $6,$7,$8::jsonb,$9,
       $10,$11::jsonb,$12::jsonb,$13
     );`,
    [
      tenantId,
      conn.connector_id,
      conn.contract_version,
      conn.provider,
      conn.control_surface,
      conn.adapter,
      conn.access_mode,
      JSON.stringify(conn.capability_ids),
      conn.credential_broker_ref,
      conn.authenticity_verification_ref,
      JSON.stringify(conn.auth_scope),
      JSON.stringify(conn.network_scope),
      conn.status,
    ]
  );

  return { tenant_id: tenantId, ...conn };
}

/**
 * Load a connector for the trusted tenant context. No caller tenant override.
 */
export async function loadConnector(backend, connectorId) {
  if (typeof connectorId !== 'string' || connectorId.length === 0) {
    throw new ConnectorValidationError('connector_id required');
  }
  const tenant = await backend.query('SELECT cur_tenant() AS t;');
  if (!tenant.rows[0]?.t) {
    throw new ConnectorValidationError('missing tenant context: connector load refused (fail-closed)');
  }
  const r = await backend.query(
    `SELECT connector_id, contract_version, provider, control_surface, adapter,
            access_mode, capability_ids, credential_broker_ref,
            authenticity_verification_ref, auth_scope, network_scope, status
     FROM connectors
     WHERE connector_id = $1;`,
    [connectorId]
  );
  const row = r.rows[0];
  if (!row) {
    throw new ConnectorValidationError(`unknown connector: ${connectorId} (fail-closed)`);
  }
  return validateConnectorContract({
    contract_version: row.contract_version,
    connector_id: row.connector_id,
    provider: row.provider,
    control_surface: row.control_surface,
    adapter: row.adapter,
    access_mode: row.access_mode,
    capability_ids: typeof row.capability_ids === 'string'
      ? JSON.parse(row.capability_ids)
      : row.capability_ids,
    credential_broker_ref: row.credential_broker_ref,
    authenticity_verification_ref: row.authenticity_verification_ref,
    auth_scope: typeof row.auth_scope === 'string' ? JSON.parse(row.auth_scope) : row.auth_scope,
    network_scope: typeof row.network_scope === 'string'
      ? JSON.parse(row.network_scope)
      : row.network_scope,
    status: row.status,
  });
}
