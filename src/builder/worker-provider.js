// src/builder/worker-provider.js
// Minimal Stage-1 WorkerProvider seam.
// Providers report worker lifecycle/evidence only. They never mark a task DONE.

import { redactSecrets, redactString } from './secrets-redact.js';

export const PROVIDER_STATUS = Object.freeze({
  CREATING: 'CREATING',
  LAUNCHED: 'LAUNCHED',
  RUNNING: 'RUNNING',
  FINISHED: 'FINISHED',
  ERROR: 'ERROR',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
});

export class WorkerProviderError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR', retryable = false, cause = null } = {}) {
    super(redactString(String(message || 'provider error')));
    this.name = 'WorkerProviderError';
    this.code = code;
    this.retryable = retryable;
    // Never retain raw causes that may nest credentials (SDK client/options).
    this.cause = cause
      ? { name: cause.name, message: redactString(String(cause.message || '')), code: cause.code }
      : null;
  }
}

export function assertWorkerProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new WorkerProviderError('worker provider is required', { code: 'INVALID_PROVIDER' });
  }
  if (typeof provider.name !== 'string' || !provider.name) {
    throw new WorkerProviderError('worker provider.name is required', { code: 'INVALID_PROVIDER' });
  }
  for (const method of ['launch', 'status', 'cancel', 'collect']) {
    if (typeof provider[method] !== 'function') {
      throw new WorkerProviderError(
        `worker provider missing method: ${method}`,
        { code: 'INVALID_PROVIDER' }
      );
    }
  }
  return provider;
}

export function normalizeProviderResult(partial) {
  if (!partial || typeof partial !== 'object') {
    throw new WorkerProviderError('provider result is required', { code: 'INVALID_RESULT' });
  }
  if (!partial.factory_run_id) {
    throw new WorkerProviderError('provider result missing factory_run_id', {
      code: 'INVALID_RESULT',
    });
  }
  if (!partial.provider) {
    throw new WorkerProviderError('provider result missing provider', {
      code: 'INVALID_RESULT',
    });
  }
  if (!Object.values(PROVIDER_STATUS).includes(partial.provider_status)) {
    throw new WorkerProviderError(
      `invalid provider_status: ${partial.provider_status}`,
      { code: 'INVALID_RESULT' }
    );
  }
  // Hard invariant: providers cannot assert task completion authority.
  if (
    Object.prototype.hasOwnProperty.call(partial, 'task_status') ||
    Object.prototype.hasOwnProperty.call(partial, 'task_done') ||
    partial.task_accepted === true
  ) {
    throw new WorkerProviderError(
      'provider must never mark a task DONE/ACCEPTED',
      { code: 'PROVIDER_AUTHORITY_VIOLATION' }
    );
  }
  return {
    factory_run_id: partial.factory_run_id,
    provider: partial.provider,
    provider_run_id: partial.provider_run_id ?? null,
    provider_agent_id: partial.provider_agent_id ?? null,
    provider_status: partial.provider_status,
    evidence: redactSecrets(
      partial.evidence && typeof partial.evidence === 'object' ? partial.evidence : {}
    ),
    error: partial.error == null ? null : redactSecrets(partial.error),
  };
}

/**
 * Abstract Stage-1 coding-worker provider.
 * Concrete Stage-1 implementation: CursorProvider only.
 */
export class WorkerProvider {
  get name() {
    throw new WorkerProviderError('WorkerProvider.name not implemented', {
      code: 'NOT_IMPLEMENTED',
    });
  }

  /** @returns {Promise<import('./worker-provider.js').ProviderResult>} */
  async launch(_args) {
    throw new WorkerProviderError('WorkerProvider.launch not implemented', {
      code: 'NOT_IMPLEMENTED',
    });
  }

  async status(_args) {
    throw new WorkerProviderError('WorkerProvider.status not implemented', {
      code: 'NOT_IMPLEMENTED',
    });
  }

  async cancel(_args) {
    throw new WorkerProviderError('WorkerProvider.cancel not implemented', {
      code: 'NOT_IMPLEMENTED',
    });
  }

  async collect(_args) {
    throw new WorkerProviderError('WorkerProvider.collect not implemented', {
      code: 'NOT_IMPLEMENTED',
    });
  }
}
