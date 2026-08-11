// src/runtime/credential-broker.js
// F-11 opaque credential broker per
// docs/master-sot/07_AUTHORITY_SECURITY_EXECUTION.md#Credential-architecture.
//
// Long-lived provider secrets stay behind this tenant-bound broker.
// Workers receive opaque credential_broker_ref values only — never raw secrets
// in worker messages, prompts, logs, or traces.
// Reader workloads do not inherit writer credentials.
//
// This module holds secrets ONLY in a process-local vault for tests/fixtures.
// Secrets are never returned by buildWorkerMessage / describeCredentialHandle.

import { randomUUID } from 'node:crypto';
import { FORBIDDEN_SECRET_FIELDS } from '../contracts/capability.js';

export class CredentialBrokerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialBrokerError';
    this.code = code;
  }
}

const WRITER_SCOPES = new Set(['write', 'writer', 'mutate', 'admin']);

/**
 * Create a tenant-bound opaque credential broker.
 * @param {{ vault?: Map<string, object> }} [opts]
 */
export function createCredentialBroker(opts = {}) {
  /** @type {Map<string, { tenant_id: string, scopes: string[], secret: string, access: 'read'|'write' }>} */
  const vault = opts.vault ?? new Map();

  function mintOpaqueRef(tenantId) {
    return `credbroker://${tenantId}/${randomUUID()}`;
  }

  return {
    /**
     * Register a secret behind an opaque ref. The secret never leaves the vault
     * via worker-message builders.
     */
    register({ tenant_id, secret, scopes = ['read'], access = 'read' }) {
      if (!tenant_id || typeof tenant_id !== 'string') {
        throw new CredentialBrokerError('INVALID_TENANT', 'tenant_id required');
      }
      if (typeof secret !== 'string' || secret.length === 0) {
        throw new CredentialBrokerError('INVALID_SECRET', 'secret required for vault registration');
      }
      if (access !== 'read' && access !== 'write') {
        throw new CredentialBrokerError('INVALID_ACCESS', 'access must be read|write');
      }
      const ref = mintOpaqueRef(tenant_id);
      vault.set(ref, {
        tenant_id,
        scopes: [...scopes],
        secret,
        access,
      });
      return { credential_broker_ref: ref, access, scopes: [...scopes] };
    },

    /**
     * Resolve a handle for an adapter under the trusted tenant. Returns opaque
     * metadata only — never the raw secret string.
     */
    resolveHandle({ tenant_id, credential_broker_ref, workload = 'reader' }) {
      if (!tenant_id) {
        throw new CredentialBrokerError('MISSING_TENANT', 'tenant_id required (fail-closed)');
      }
      if (!credential_broker_ref || typeof credential_broker_ref !== 'string') {
        throw new CredentialBrokerError('MISSING_REF', 'credential_broker_ref required');
      }
      const entry = vault.get(credential_broker_ref);
      if (!entry) {
        throw new CredentialBrokerError('UNKNOWN_REF', 'unknown credential_broker_ref (fail-closed)');
      }
      if (entry.tenant_id !== tenant_id) {
        throw new CredentialBrokerError('TENANT_MISMATCH', 'credential ref tenant mismatch (fail-closed)');
      }
      // Reader workloads do not inherit writer credentials.
      if (workload === 'reader' && entry.access === 'write') {
        throw new CredentialBrokerError(
          'WRITER_CREDENTIAL_DENIED_TO_READER',
          'reader workloads do not inherit writer credentials'
        );
      }
      if (workload === 'reader' && entry.scopes.some((s) => WRITER_SCOPES.has(String(s).toLowerCase()))) {
        throw new CredentialBrokerError(
          'WRITER_SCOPE_DENIED_TO_READER',
          'reader workloads do not inherit writer credential scopes'
        );
      }
      return {
        credential_broker_ref,
        tenant_id: entry.tenant_id,
        access: entry.access,
        scopes: [...entry.scopes],
        // Explicit: raw secret is NOT included on the handle.
        has_secret: true,
      };
    },

    /**
     * Build a worker message that may only carry opaque refs — never raw secrets.
     * Stop condition: raw secret in worker message.
     */
    buildWorkerMessage({
      tenant_id,
      connector_id,
      capability_id,
      credential_broker_ref,
      operation,
      payload = {},
    }) {
      const handle = this.resolveHandle({
        tenant_id,
        credential_broker_ref,
        workload: 'reader',
      });

      const message = {
        tenant_id,
        connector_id,
        capability_id,
        operation,
        credential_broker_ref: handle.credential_broker_ref,
        payload,
      };

      assertNoRawSecretsInWorkerMessage(message);
      return Object.freeze(message);
    },

    /** Test/introspection only: vault size. Does not expose secrets. */
    size() {
      return vault.size;
    },
  };
}

/**
 * Fail closed if a worker message contains raw credential-bearing fields or
 * inline secret-shaped values.
 */
export function assertNoRawSecretsInWorkerMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new CredentialBrokerError('INVALID_MESSAGE', 'worker message must be an object');
  }
  const stack = [{ path: '', value: message }];
  while (stack.length) {
    const { path, value } = stack.pop();
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((v, i) => stack.push({ path: `${path}[${i}]`, value: v }));
      continue;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        const key = k.toLowerCase();
        if (FORBIDDEN_SECRET_FIELDS.includes(key)) {
          throw new CredentialBrokerError(
            'RAW_SECRET_IN_WORKER_MESSAGE',
            `raw secret field forbidden in worker message: ${path ? path + '.' : ''}${k}`
          );
        }
        stack.push({ path: path ? `${path}.${k}` : k, value: v });
      }
      continue;
    }
    if (typeof value === 'string') {
      if (/^(sk-|Bearer |-----BEGIN )/i.test(value)) {
        throw new CredentialBrokerError(
          'RAW_SECRET_IN_WORKER_MESSAGE',
          `raw secret value forbidden in worker message at ${path || '<root>'}`
        );
      }
    }
  }
  return true;
}
