// CursorProvider — sole Stage-1 coding WorkerProvider implementation.
// Uses official @cursor/sdk cloud runtime for isolated workers.
// Never marks task DONE. Never injects production business credentials.

import {
  PROVIDER_STATUS,
  WorkerProvider,
  WorkerProviderError,
  normalizeProviderResult,
} from '../worker-provider.js';
import { createCursorSdkAdapter } from './cursor-sdk-adapter.js';
import { loadCursorApiKey } from './cursor-api-key.js';

const FORBIDDEN_ENV_NAME =
  /^(GHL_|HIGHLEVEL_|META_|FACEBOOK_|STRIPE_|PAYMENT_|PAYPAL_|TWILIO_|CUSTOMER_|CRM_|PROD_|PRODUCTION_)/i;

const FORBIDDEN_ENV_VALUE_HINT =
  /(GHL|HIGHLEVEL|META_ACCESS|FACEBOOK|STRIPE|PAYMENT|CUSTOMER_SECRET)/i;

export function assertNoBusinessCredentials(envVars = {}) {
  for (const [name, value] of Object.entries(envVars || {})) {
    if (FORBIDDEN_ENV_NAME.test(name) || FORBIDDEN_ENV_VALUE_HINT.test(name)) {
      throw new WorkerProviderError(
        `refusing production/business credential env var: ${name}`,
        { code: 'BUSINESS_CREDENTIAL_FORBIDDEN' }
      );
    }
    if (typeof value === 'string' && FORBIDDEN_ENV_VALUE_HINT.test(value)) {
      throw new WorkerProviderError(
        `refusing env var value that looks like a business credential: ${name}`,
        { code: 'BUSINESS_CREDENTIAL_FORBIDDEN' }
      );
    }
    if (/^CURSOR_/.test(name)) {
      throw new WorkerProviderError(
        `CURSOR_* env vars are reserved and cannot be passed to cloud workers: ${name}`,
        { code: 'RESERVED_ENV' }
      );
    }
  }
  return envVars;
}

export function mapCursorRunStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'creating') return PROVIDER_STATUS.CREATING;
  if (s === 'launched') return PROVIDER_STATUS.LAUNCHED;
  if (s === 'running') return PROVIDER_STATUS.RUNNING;
  if (s === 'finished' || s === 'completed') return PROVIDER_STATUS.FINISHED;
  if (s === 'error' || s === 'failed') return PROVIDER_STATUS.ERROR;
  if (s === 'cancelled' || s === 'canceled') return PROVIDER_STATUS.CANCELLED;
  if (s === 'expired') return PROVIDER_STATUS.EXPIRED;
  if (s === 'timeout' || s === 'timed_out') return PROVIDER_STATUS.TIMEOUT;
  return PROVIDER_STATUS.UNKNOWN;
}

function providerErrorFrom(err, code = 'PROVIDER_ERROR') {
  return {
    name: err?.name || 'Error',
    message: String(err?.message || err),
    retryable: Boolean(err?.isRetryable ?? err?.retryable),
    code: err?.code || code,
  };
}

export class CursorProvider extends WorkerProvider {
  constructor({
    apiKey = null,
    apiKeyLoader = loadCursorApiKey,
    sdkAdapter = null,
    repoUrl = 'https://github.com/mac313248/jarvis-agencyos.git',
    startingRef = 'main',
    model = 'composer-2.5',
    autoCreatePR = false,
    includeCloudMetadata = false,
  } = {}) {
    super();
    this._apiKey = apiKey;
    this._apiKeyLoader = apiKeyLoader;
    this._sdk = sdkAdapter || createCursorSdkAdapter();
    this.repoUrl = repoUrl;
    this.startingRef = startingRef;
    this.model = model;
    this.autoCreatePR = autoCreatePR;
    this.includeCloudMetadata = includeCloudMetadata;
    // In-memory handles for the active process; durable IDs live in Builder Core.
    this._handles = new Map(); // factory_run_id -> { agent, run }
  }

  get name() {
    return 'cursor';
  }

  _resolveApiKey() {
    if (this._apiKey) return this._apiKey;
    const loaded = this._apiKeyLoader();
    this._apiKey = loaded.apiKey;
    return this._apiKey;
  }

  async probeAuth() {
    try {
      const apiKey = this._resolveApiKey();
      const models = await this._sdk.listModels(apiKey);
      return {
        ok: true,
        model_count: Array.isArray(models) ? models.length : null,
      };
    } catch (err) {
      return {
        ok: false,
        error: providerErrorFrom(err, 'AUTH_FAILED'),
      };
    }
  }

  async launch({
    factory_run_id,
    task,
    prompt,
    envVars = {},
  }) {
    if (!factory_run_id) {
      throw new WorkerProviderError('launch requires factory_run_id', {
        code: 'INVALID_LAUNCH',
      });
    }
    if (!task?.task_id) {
      throw new WorkerProviderError('launch requires locked task', {
        code: 'INVALID_LAUNCH',
      });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new WorkerProviderError('launch requires prompt', {
        code: 'INVALID_LAUNCH',
      });
    }

    assertNoBusinessCredentials(envVars);

    let apiKey;
    try {
      apiKey = this._resolveApiKey();
    } catch (err) {
      throw new WorkerProviderError(err.message, {
        code: 'AUTH_UNAVAILABLE',
        retryable: false,
        cause: err,
      });
    }

    try {
      // Do not send cloud.metadata unless explicitly enabled: some accounts
      // reject it with feature_unavailable. factory_run_id mapping remains
      // authoritative in Builder Core durable state.
      const cloud = {
        repos: [{ url: this.repoUrl, startingRef: this.startingRef }],
        autoCreatePR: this.autoCreatePR,
        skipReviewerRequest: true,
        ...(Object.keys(envVars).length ? { envVars } : {}),
      };
      if (this.includeCloudMetadata) {
        cloud.metadata = {
          factory_run_id,
          task_id: task.task_id,
          builder_trust_domain: 'BUILDER_CORE',
        };
      }
      const agent = await this._sdk.createAgent({
        apiKey,
        model: { id: this.model },
        cloud,
      });

      const run = await agent.send(prompt, {
        // Keep prompt free of ambient production credentials.
      });

      this._handles.set(factory_run_id, {
        agent,
        run,
        provider_run_id: run.id,
        provider_agent_id: agent.agentId,
      });

      return normalizeProviderResult({
        factory_run_id,
        provider: this.name,
        provider_run_id: run.id,
        provider_agent_id: agent.agentId,
        provider_status: mapCursorRunStatus(run.status) === PROVIDER_STATUS.UNKNOWN
          ? PROVIDER_STATUS.LAUNCHED
          : mapCursorRunStatus(run.status),
        evidence: {
          launched_at: new Date().toISOString(),
          repo_url: this.repoUrl,
          starting_ref: this.startingRef,
          model: this.model,
          runtime: 'cloud',
        },
        error: null,
      });
    } catch (err) {
      throw new WorkerProviderError(
        `cursor launch failed: ${err.message}`,
        {
          code: err?.name === 'AuthenticationError' ? 'AUTH_FAILED' : 'LAUNCH_FAILED',
          retryable: Boolean(err?.isRetryable),
          cause: err,
        }
      );
    }
  }

  async status({ factory_run_id, provider_run_id, provider_agent_id }) {
    return this._inspect({
      factory_run_id,
      provider_run_id,
      provider_agent_id,
      mode: 'status',
    });
  }

  async cancel({ factory_run_id, provider_run_id, provider_agent_id }) {
    const apiKey = this._resolveApiKey();
    try {
      await this._sdk.cancelRun(provider_run_id, {
        runtime: 'cloud',
        agentId: provider_agent_id,
        apiKey,
      });
      return normalizeProviderResult({
        factory_run_id,
        provider: this.name,
        provider_run_id,
        provider_agent_id,
        provider_status: PROVIDER_STATUS.CANCELLED,
        evidence: {
          cancelled_at: new Date().toISOString(),
        },
        error: null,
      });
    } catch (err) {
      throw new WorkerProviderError(`cursor cancel failed: ${err.message}`, {
        code: 'CANCEL_FAILED',
        retryable: Boolean(err?.isRetryable),
        cause: err,
      });
    }
  }

  async collect({ factory_run_id, provider_run_id, provider_agent_id, wait = false }) {
    const inspected = await this._inspect({
      factory_run_id,
      provider_run_id,
      provider_agent_id,
      mode: 'collect',
      wait,
    });
    return inspected;
  }

  async _inspect({
    factory_run_id,
    provider_run_id,
    provider_agent_id,
    mode,
    wait = false,
  }) {
    if (!provider_run_id || !provider_agent_id) {
      throw new WorkerProviderError(
        `${mode} requires provider_run_id and provider_agent_id`,
        { code: 'INVALID_RUN_REF' }
      );
    }
    const apiKey = this._resolveApiKey();
    try {
      const handle = this._handles.get(factory_run_id);
      let run = handle?.run;
      if (!run) {
        run = await this._sdk.getRun(provider_run_id, {
          runtime: 'cloud',
          agentId: provider_agent_id,
          apiKey,
        });
      }

      let waitResult = null;
      const terminal = ['finished', 'error', 'cancelled', 'canceled'].includes(
        String(run.status || '').toLowerCase()
      );
      if (wait || (mode === 'collect' && terminal && typeof run.wait === 'function')) {
        waitResult = await run.wait();
      }

      const statusSource = waitResult?.status || run.status;
      const evidence = {
        inspected_at: new Date().toISOString(),
        mode,
        run_status: run.status,
        result_text:
          waitResult?.result != null
            ? String(waitResult.result).slice(0, 4000)
            : undefined,
        git: waitResult?.git || undefined,
        usage: waitResult?.usage || run.usage || undefined,
      };

      return normalizeProviderResult({
        factory_run_id,
        provider: this.name,
        provider_run_id,
        provider_agent_id,
        provider_status: mapCursorRunStatus(statusSource),
        evidence,
        error:
          mapCursorRunStatus(statusSource) === PROVIDER_STATUS.ERROR
            ? {
                name: 'CursorRunError',
                message: evidence.result_text || 'cursor run status=error',
                retryable: false,
                code: 'RUN_ERROR',
              }
            : null,
      });
    } catch (err) {
      // Preserve truthful provider/auth errors; do not invent success.
      return normalizeProviderResult({
        factory_run_id,
        provider: this.name,
        provider_run_id,
        provider_agent_id,
        provider_status: PROVIDER_STATUS.ERROR,
        evidence: {
          inspected_at: new Date().toISOString(),
          mode,
        },
        error: providerErrorFrom(err, err?.name === 'AuthenticationError' ? 'AUTH_FAILED' : 'STATUS_FAILED'),
      });
    }
  }
}

export function createCursorProvider(options) {
  return new CursorProvider(options);
}
