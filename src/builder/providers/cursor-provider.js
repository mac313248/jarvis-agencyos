// CursorProvider — sole Stage-1 coding WorkerProvider implementation.
// Uses official @cursor/sdk cloud runtime for isolated workers.
// Never marks task DONE. Never injects production business credentials.

import { inspect } from 'node:util';
import {
  PROVIDER_STATUS,
  WorkerProvider,
  WorkerProviderError,
  normalizeProviderResult,
} from '../worker-provider.js';
import { createCursorSdkAdapter } from './cursor-sdk-adapter.js';
import { loadCursorApiKey } from './cursor-api-key.js';
import { redactSecrets, safeErrorFields, REDACTED } from '../secrets-redact.js';

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

function providerErrorFrom(err, code = 'PROVIDER_ERROR', extraSecrets = []) {
  return safeErrorFields(err, code, extraSecrets);
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
    // Non-enumerable so JSON.stringify / util.inspect cannot leak the key.
    Object.defineProperty(this, '_apiKey', {
      value: apiKey,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(this, '_apiKeyLoader', {
      value: apiKeyLoader,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(this, '_sdk', {
      value: sdkAdapter || createCursorSdkAdapter(),
      writable: false,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(this, '_handles', {
      value: new Map(),
      writable: false,
      enumerable: false,
      configurable: true,
    });
    this.repoUrl = repoUrl;
    this.startingRef = startingRef;
    this.model = model;
    this.autoCreatePR = autoCreatePR;
    this.includeCloudMetadata = includeCloudMetadata;
  }

  get name() {
    return 'cursor';
  }

  toJSON() {
    return {
      name: this.name,
      repoUrl: this.repoUrl,
      startingRef: this.startingRef,
      model: this.model,
      autoCreatePR: this.autoCreatePR,
      apiKey: REDACTED,
    };
  }

  [inspect.custom]() {
    return `CursorProvider ${JSON.stringify(this.toJSON())}`;
  }

  _resolveApiKey() {
    if (this._apiKey) return this._apiKey;
    const loaded = this._apiKeyLoader();
    this._apiKey = loaded.apiKey;
    return this._apiKey;
  }

  _secretBag() {
    return this._apiKey ? [this._apiKey] : [];
  }

  _safeEvidence(evidence = {}) {
    return redactSecrets(evidence, { extraSecrets: this._secretBag() });
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
        error: providerErrorFrom(err, 'AUTH_FAILED', this._secretBag()),
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
      const safe = providerErrorFrom(err, 'AUTH_UNAVAILABLE', this._secretBag());
      throw new WorkerProviderError(safe.message, {
        code: 'AUTH_UNAVAILABLE',
        retryable: false,
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
      // apiKey is passed in-memory to the SDK only — never into evidence/logs.
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
        evidence: this._safeEvidence({
          launched_at: new Date().toISOString(),
          repo_url: this.repoUrl,
          starting_ref: this.startingRef,
          model: this.model,
          runtime: 'cloud',
        }),
        error: null,
      });
    } catch (err) {
      const safe = providerErrorFrom(
        err,
        err?.name === 'AuthenticationError' ? 'AUTH_FAILED' : 'LAUNCH_FAILED',
        this._secretBag()
      );
      throw new WorkerProviderError(`cursor launch failed: ${safe.message}`, {
        code: safe.code,
        retryable: safe.retryable,
      });
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
      const safe = providerErrorFrom(err, 'CANCEL_FAILED', this._secretBag());
      throw new WorkerProviderError(`cursor cancel failed: ${safe.message}`, {
        code: 'CANCEL_FAILED',
        retryable: safe.retryable,
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
      // Always refresh from Cursor API. The in-memory handle from agent.send()
      // can transiently report status=error during stream setup while the
      // cloud run continues and later FINISHES (observed on live smoke
      // run-1aaa834e / bc-d7678c62).
      const run = await this._sdk.getRun(provider_run_id, {
        runtime: 'cloud',
        agentId: provider_agent_id,
        apiKey,
      });

      let waitResult = null;
      const apiStatus = String(run.status || '').toLowerCase();
      const terminal = ['finished', 'error', 'cancelled', 'canceled'].includes(
        apiStatus
      );
      // Prefer waiting on the live handle only while API still says non-terminal.
      const waitTarget =
        wait &&
        !terminal &&
        handle?.run &&
        typeof handle.run.wait === 'function'
          ? handle.run
          : run;
      if (
        wait ||
        (mode === 'collect' && terminal && typeof waitTarget.wait === 'function')
      ) {
        if (typeof waitTarget.wait === 'function') {
          waitResult = await waitTarget.wait();
        }
      }

      const statusSource = waitResult?.status || run.status;
      // Cursor SDK cloud: git = { branches: [{ repoUrl, branch?, prUrl? }] }.
      // Exact commit_sha is resolved later via GitHub landing truth.
      const rawGit = waitResult?.git || run.git || null;
      const branch0 = Array.isArray(rawGit?.branches) ? rawGit.branches[0] : null;
      const git = rawGit
        ? {
            ...rawGit,
            branch: branch0?.branch || rawGit.branch,
            branchName: branch0?.branch || rawGit.branchName,
            prUrl: branch0?.prUrl || rawGit.prUrl,
          }
        : run.branch || run.prUrl
          ? {
              branchName: run.branch || run.branchName,
              prUrl: run.prUrl || run.pullRequestUrl,
            }
          : undefined;
      const evidence = this._safeEvidence({
        inspected_at: new Date().toISOString(),
        mode,
        run_status: run.status,
        result_text:
          waitResult?.result != null
            ? String(waitResult.result).slice(0, 4000)
            : run.result != null
              ? String(run.result).slice(0, 4000)
              : undefined,
        git: git || undefined,
        // Never serialize SDK run/agent handles (they nest apiKey).
        usage: waitResult?.usage || run.usage || undefined,
      });

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
      // Never attach raw SDK objects or credential-bearing causes.
      return normalizeProviderResult({
        factory_run_id,
        provider: this.name,
        provider_run_id,
        provider_agent_id,
        provider_status: PROVIDER_STATUS.ERROR,
        evidence: this._safeEvidence({
          inspected_at: new Date().toISOString(),
          mode,
        }),
        error: providerErrorFrom(
          err,
          err?.name === 'AuthenticationError' ? 'AUTH_FAILED' : 'STATUS_FAILED',
          this._secretBag()
        ),
      });
    }
  }
}

export function createCursorProvider(options) {
  return new CursorProvider(options);
}
