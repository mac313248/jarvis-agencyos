// Credential redaction — fake secrets must never appear in durable/serialized surfaces.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import {
  createBuilderCore,
  createCursorProvider,
  PROVIDER_STATUS,
  REDACTED,
  redactSecrets,
  redactString,
  safeJsonStringify,
  isSensitiveKey,
  WorkerProviderError,
  EVENT_TYPE,
} from '../src/builder/index.js';

const FAKE_CURSOR_KEY = 'crsr_TEST_SECRET_VALUE_NEVER_LEAK_xyz123abc';
const FAKE_OPENAI = 'sk-TEST_OPENAI_SECRET_NEVER_LEAK_999';
const FAKE_GH = 'ghp_TEST_GITHUB_TOKEN_NEVER_LEAK_888';
const FAKE_GHL = 'ghl_TEST_LOCATION_TOKEN_NEVER_LEAK';

function assertNoLeak(text) {
  const s = String(text);
  assert.equal(s.includes(FAKE_CURSOR_KEY), false, `leaked cursor key in: ${s.slice(0, 200)}`);
  assert.equal(s.includes(FAKE_OPENAI), false, `leaked openai key in: ${s.slice(0, 200)}`);
  assert.equal(s.includes(FAKE_GH), false, `leaked github token in: ${s.slice(0, 200)}`);
  assert.equal(s.includes(FAKE_GHL), false, `leaked ghl token in: ${s.slice(0, 200)}`);
}

describe('Stage-1 secret redaction', () => {
  it('redacts sensitive keys and known secret value shapes', () => {
    assert.equal(isSensitiveKey('CURSOR_API_KEY'), true);
    assert.equal(isSensitiveKey('CODEX_API_KEY'), true);
    assert.equal(isSensitiveKey('OPENAI_API_KEY'), true);
    assert.equal(isSensitiveKey('GITHUB_TOKEN'), true);
    assert.equal(isSensitiveKey('GHL_API_KEY'), true);
    assert.equal(isSensitiveKey('META_ACCESS_TOKEN'), true);
    assert.equal(isSensitiveKey('STRIPE_SECRET_KEY'), true);
    assert.equal(isSensitiveKey('branch'), false);

    const obj = redactSecrets({
      CURSOR_API_KEY: FAKE_CURSOR_KEY,
      OPENAI_API_KEY: FAKE_OPENAI,
      GITHUB_TOKEN: FAKE_GH,
      GHL_API_KEY: FAKE_GHL,
      apiKey: FAKE_CURSOR_KEY,
      nested: { client: { apiKey: FAKE_CURSOR_KEY, baseUrl: 'https://api.cursor.com' } },
      note: `token=${FAKE_CURSOR_KEY}`,
    });
    assert.equal(obj.CURSOR_API_KEY, REDACTED);
    assert.equal(obj.OPENAI_API_KEY, REDACTED);
    assert.equal(obj.GITHUB_TOKEN, REDACTED);
    assert.equal(obj.GHL_API_KEY, REDACTED);
    assert.equal(obj.apiKey, REDACTED);
    assert.equal(obj.nested.client.apiKey, REDACTED);
    assert.equal(obj.nested.client.baseUrl, 'https://api.cursor.com');
    assertNoLeak(JSON.stringify(obj));
    assertNoLeak(redactString(`CURSOR_API_KEY=${FAKE_CURSOR_KEY}`));
    assertNoLeak(safeJsonStringify({ password: 'x', api_key: FAKE_CURSOR_KEY }));
  });

  it('CursorProvider never exposes key via JSON/inspect/errors/evidence', async () => {
    const sdk = {
      agents: new Map(),
      runs: new Map(),
      async listModels() {
        throw Object.assign(new Error(`Invalid key ${FAKE_CURSOR_KEY}`), {
          name: 'AuthenticationError',
        });
      },
      async createAgent(options) {
        // Simulate SDK retaining apiKey on nested client/options (the prior leak shape).
        const agentId = 'bc-fake-secret-test';
        const agent = {
          agentId,
          client: { apiKey: options.apiKey, baseUrl: 'https://api.cursor.com' },
          options: { apiKey: options.apiKey },
          send: async () => {
            const run = {
              id: 'run-fake-secret-test',
              status: 'running',
              wait: async () => ({ status: 'finished', result: 'ok', git: { branches: [] } }),
            };
            this.runs.set(run.id, run);
            return run;
          },
        };
        this.agents.set(agentId, agent);
        return agent;
      },
      async getRun(id) {
        return this.runs.get(id) || { id, status: 'running' };
      },
      async cancelRun() {},
    };
    const provider = createCursorProvider({
      apiKey: FAKE_CURSOR_KEY,
      sdkAdapter: {
        listModels: (k) => sdk.listModels(k),
        createAgent: (o) => sdk.createAgent(o),
        getRun: (id, o) => sdk.getRun(id, o),
        cancelRun: (id, o) => sdk.cancelRun(id, o),
      },
    });

    assertNoLeak(JSON.stringify(provider));
    assertNoLeak(inspect(provider, { depth: 10, showHidden: true }));
    assert.equal(provider.toJSON().apiKey, REDACTED);

    const probe = await provider.probeAuth();
    assert.equal(probe.ok, false);
    assertNoLeak(JSON.stringify(probe));
    assertNoLeak(probe.error.message);

    const launched = await provider.launch({
      factory_run_id: 'run_secret_test',
      task: { task_id: 'task_secret_test' },
      prompt: 'do not leak',
    });
    assertNoLeak(JSON.stringify(launched));

    // Poison evidence-like SDK dump must be redacted by normalize path.
    const status = await provider.status({
      factory_run_id: 'run_secret_test',
      provider_run_id: launched.provider_run_id,
      provider_agent_id: launched.provider_agent_id,
    });
    assertNoLeak(JSON.stringify(status));

    // Force error path that previously could echo SDK messages containing keys.
    sdk.getRun = async () => {
      throw new Error(`status failed with ${FAKE_CURSOR_KEY}`);
    };
    const failed = await provider.status({
      factory_run_id: 'run_secret_test',
      provider_run_id: launched.provider_run_id,
      provider_agent_id: launched.provider_agent_id,
    });
    assert.equal(failed.provider_status, PROVIDER_STATUS.ERROR);
    assertNoLeak(JSON.stringify(failed));
    assertNoLeak(failed.error.message);
  });

  it('durable store + trajectory redacts secrets from evidence/events/errors', async () => {
    const provider = createCursorProvider({
      apiKey: FAKE_CURSOR_KEY,
      sdkAdapter: {
        listModels: async () => [{ id: 'composer-2.5' }],
        createAgent: async () => ({
          agentId: 'bc-1',
          send: async () => ({
            id: 'run-1',
            status: 'error',
            wait: async () => ({ status: 'error', result: `boom ${FAKE_CURSOR_KEY}` }),
          }),
        }),
        getRun: async () => ({
          id: 'run-1',
          status: 'error',
          result: `cursor fail ${FAKE_CURSOR_KEY}`,
          wait: async () => ({ status: 'error', result: `cursor fail ${FAKE_CURSOR_KEY}` }),
        }),
        cancelRun: async () => {},
      },
    });
    const core = createBuilderCore({ workerProvider: provider });
    const task = core.createAndLockTask({
      intent: 'secret redaction store test',
      acceptance_ref: 'tests/builder-stage1-secrets-redact.test.mjs',
      allowed_paths: ['artifacts/x.txt'],
      tool_manifest: {
        providers: ['cursor', 'github'],
        tools: ['coding_worker'],
        mode: 'build',
      },
    });
    const { run } = await core.launchCodingWorker({
      task_id: task.task_id,
      prompt: 'x',
    });
    const observed = await core.refreshWorkerStatus(run.factory_run_id);
    assertNoLeak(JSON.stringify(observed));
    assertNoLeak(JSON.stringify(core.getRun(run.factory_run_id)));

    const events = core.store.listEventsForTask(task.task_id);
    assertNoLeak(JSON.stringify(events));
    assert.ok(events.some((e) => e.event_type === EVENT_TYPE.WORKER_STATUS));

    // Direct store write with nested credential shape.
    const stored = core.store.appendEvent({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      event_type: EVENT_TYPE.WORKER_STATUS,
      payload: {
        client: { apiKey: FAKE_CURSOR_KEY },
        env: { CURSOR_API_KEY: FAKE_CURSOR_KEY, OPENAI_API_KEY: FAKE_OPENAI },
      },
    });
    assert.ok(stored?.payload, 'expected stored event payload');
    assert.equal(stored.payload?.client?.apiKey, REDACTED);
    assert.equal(stored.payload?.env?.CURSOR_API_KEY, REDACTED);
    assert.equal(stored.payload?.env?.OPENAI_API_KEY, REDACTED);
    assertNoLeak(JSON.stringify(stored));
    assertNoLeak(JSON.stringify(core.store.listEventsForTask(task.task_id)));

    const err = new WorkerProviderError(`bad ${FAKE_CURSOR_KEY}`, {
      cause: { message: FAKE_CURSOR_KEY, name: 'Error' },
    });
    assertNoLeak(err.message);
    assertNoLeak(JSON.stringify(err.cause));
  });

  it('loadCursorApiKey errors never embed key material', async () => {
    const { loadCursorApiKey } = await import('../src/builder/providers/cursor-api-key.js');
    assert.throws(
      () =>
        loadCursorApiKey({
          allowKeychain: false,
          allowEnv: false,
          env: { CURSOR_API_KEY: FAKE_CURSOR_KEY },
        }),
      (e) => {
        assertNoLeak(e.message);
        return /unavailable/i.test(e.message);
      }
    );
    // Env inject works but returned value is for in-memory use only — callers must not log it.
    const loaded = loadCursorApiKey({
      allowKeychain: false,
      allowEnv: true,
      env: { CURSOR_API_KEY: FAKE_CURSOR_KEY },
    });
    assert.equal(loaded.apiKey, FAKE_CURSOR_KEY);
    assert.equal(loaded.source, 'env');
  });
});
