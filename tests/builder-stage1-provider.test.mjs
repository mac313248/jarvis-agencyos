// Stage-1 Builder — WorkerProvider + CursorProvider (Build Order items 6–8).
// Deterministic boundary tests use an injectable fake SDK/provider.
// Live Cursor smoke is attempted only when credentials work; otherwise the
// suite records the truthful auth failure without inventing API success.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_STATUS,
  RUN_STATUS,
  EVENT_TYPE,
  FAILURE_CLASS,
  createBuilderCore,
  BuilderCoreError,
  WorkerProvider,
  WorkerProviderError,
  PROVIDER_STATUS,
  assertWorkerProvider,
  normalizeProviderResult,
  CursorProvider,
  createCursorProvider,
  assertNoBusinessCredentials,
  mapCursorRunStatus,
  createCursorSdkAdapter,
} from '../src/builder/index.js';

const INTENT = {
  intent: 'Prove Cursor WorkerProvider lifecycle fencing',
  acceptance_ref: 'tests/builder-stage1-provider.test.mjs',
  allowed_paths: ['src/builder/', 'tests/builder-stage1-provider.test.mjs'],
  tool_manifest: {
    providers: ['cursor', 'github'],
    tools: ['repo_read', 'coding_worker'],
    mode: 'build',
  },
  review_required: true,
};

class FakeCursorSdk {
  constructor() {
    this.agents = new Map();
    this.runs = new Map();
    this.failAuth = false;
    this.failLaunchMessage = null;
    this.cancelCalls = [];
    this.createCalls = [];
    this.getRunCalls = [];
  }

  async listModels(_apiKey) {
    if (this.failAuth) {
      const err = new Error('Invalid User API Key');
      err.name = 'AuthenticationError';
      err.isRetryable = false;
      throw err;
    }
    return [{ id: 'composer-2.5' }];
  }

  async createAgent(options) {
    if (this.failAuth) {
      const err = new Error('Invalid User API Key');
      err.name = 'AuthenticationError';
      err.isRetryable = false;
      throw err;
    }
    if (this.failLaunchMessage) {
      throw new Error(this.failLaunchMessage);
    }
    this.createCalls.push(options);
    const agentId = `bc-fake-${this.agents.size + 1}`;
    const agent = {
      agentId,
      send: async (_prompt) => {
        const runId = `run-fake-${this.runs.size + 1}`;
        const run = {
          id: runId,
          status: 'running',
          usage: undefined,
          supports: (op) => op === 'cancel' || op === 'wait',
          cancel: async () => {
            run.status = 'cancelled';
          },
          wait: async () => ({
            status: run.status === 'running' ? 'finished' : run.status,
            result: run.result != null ? run.result : 'fake worker output',
            git: run.git || {
              branches: [
                {
                  repoUrl: options.cloud.repos[0].url,
                  branch: 'cursor/fake-branch',
                },
              ],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        };
        this.runs.set(runId, { run, agentId });
        return run;
      },
    };
    this.agents.set(agentId, agent);
    return agent;
  }

  async getRun(runId, { agentId }) {
    this.getRunCalls.push({ runId, agentId });
    const entry = this.runs.get(runId);
    if (!entry || entry.agentId !== agentId) {
      throw new Error(`unknown run ${runId}`);
    }
    return entry.run;
  }

  async cancelRun(runId, { agentId }) {
    this.cancelCalls.push({ runId, agentId });
    const entry = this.runs.get(runId);
    if (!entry || entry.agentId !== agentId) {
      throw new Error(`unknown run ${runId}`);
    }
    entry.run.status = 'cancelled';
  }
}

function fakeAdapter(sdk) {
  return {
    listModels: (key) => sdk.listModels(key),
    createAgent: (opts) => sdk.createAgent(opts),
    getRun: (id, opts) => sdk.getRun(id, opts),
    cancelRun: (id, opts) => sdk.cancelRun(id, opts),
  };
}

describe('Stage-1 WorkerProvider + CursorProvider (items 6–8)', () => {
  describe('WorkerProvider interface', () => {
    it('requires launch/status/cancel/collect', () => {
      assert.throws(
        () => assertWorkerProvider({ name: 'x' }),
        (err) => err instanceof WorkerProviderError
      );
      const provider = {
        name: 'cursor',
        launch: async () => ({}),
        status: async () => ({}),
        cancel: async () => ({}),
        collect: async () => ({}),
      };
      assert.equal(assertWorkerProvider(provider).name, 'cursor');
    });

    it('rejects provider results that claim task DONE', () => {
      assert.throws(
        () =>
          normalizeProviderResult({
            factory_run_id: 'run_1',
            provider: 'cursor',
            provider_status: PROVIDER_STATUS.FINISHED,
            task_status: 'DONE',
          }),
        (err) =>
          err instanceof WorkerProviderError &&
          err.code === 'PROVIDER_AUTHORITY_VIOLATION'
      );
      assert.throws(
        () =>
          normalizeProviderResult({
            factory_run_id: 'run_1',
            provider: 'cursor',
            provider_status: PROVIDER_STATUS.FINISHED,
            task_done: true,
          }),
        (err) => err.code === 'PROVIDER_AUTHORITY_VIOLATION'
      );
    });

    it('abstract WorkerProvider methods fail closed', async () => {
      const wp = new WorkerProvider();
      await assert.rejects(() => wp.launch({}), (err) => err.code === 'NOT_IMPLEMENTED');
      await assert.rejects(() => wp.status({}), (err) => err.code === 'NOT_IMPLEMENTED');
      await assert.rejects(() => wp.cancel({}), (err) => err.code === 'NOT_IMPLEMENTED');
      await assert.rejects(() => wp.collect({}), (err) => err.code === 'NOT_IMPLEMENTED');
    });
  });

  describe('CursorProvider security + mapping', () => {
    it('maps cursor statuses and forbids business credentials', () => {
      assert.equal(mapCursorRunStatus('running'), PROVIDER_STATUS.RUNNING);
      assert.equal(mapCursorRunStatus('finished'), PROVIDER_STATUS.FINISHED);
      assert.equal(mapCursorRunStatus('cancelled'), PROVIDER_STATUS.CANCELLED);
      assert.throws(
        () => assertNoBusinessCredentials({ GHL_API_KEY: 'x' }),
        (err) => err.code === 'BUSINESS_CREDENTIAL_FORBIDDEN'
      );
      assert.throws(
        () => assertNoBusinessCredentials({ STRIPE_SECRET: 'x' }),
        (err) => err.code === 'BUSINESS_CREDENTIAL_FORBIDDEN'
      );
      assert.throws(
        () => assertNoBusinessCredentials({ CURSOR_API_KEY: 'x' }),
        (err) => err.code === 'RESERVED_ENV'
      );
      assert.deepEqual(assertNoBusinessCredentials({ NODE_ENV: 'test' }), {
        NODE_ENV: 'test',
      });
    });

    it('launch/status/cancel/collect with fake SDK and maps factory_run_id', async () => {
      const sdk = new FakeCursorSdk();
      const provider = createCursorProvider({
        apiKey: 'test-key',
        sdkAdapter: fakeAdapter(sdk),
        repoUrl: 'https://github.com/mac313248/jarvis-agencyos.git',
      });
      const task = { task_id: 'task_demo', status: TASK_STATUS.LOCKED };
      const launched = await provider.launch({
        factory_run_id: 'run_factory_1',
        task,
        prompt: 'noop lifecycle probe',
      });
      assert.equal(launched.provider, 'cursor');
      assert.equal(launched.factory_run_id, 'run_factory_1');
      assert.ok(launched.provider_run_id.startsWith('run-fake-'));
      assert.ok(launched.provider_agent_id.startsWith('bc-fake-'));
      assert.equal(sdk.createCalls[0].cloud.metadata, undefined);

      const withMeta = createCursorProvider({
        apiKey: 'test-key',
        sdkAdapter: fakeAdapter(sdk),
        includeCloudMetadata: true,
      });
      await withMeta.launch({
        factory_run_id: 'run_factory_meta',
        task,
        prompt: 'meta probe',
      });
      assert.equal(
        sdk.createCalls.at(-1).cloud.metadata.factory_run_id,
        'run_factory_meta'
      );

      const st = await provider.status({
        factory_run_id: 'run_factory_1',
        provider_run_id: launched.provider_run_id,
        provider_agent_id: launched.provider_agent_id,
      });
      assert.equal(st.provider_status, PROVIDER_STATUS.RUNNING);

      const cancelled = await provider.cancel({
        factory_run_id: 'run_factory_1',
        provider_run_id: launched.provider_run_id,
        provider_agent_id: launched.provider_agent_id,
      });
      assert.equal(cancelled.provider_status, PROVIDER_STATUS.CANCELLED);
      assert.equal(sdk.cancelCalls.length, 1);

      // Second launch+collect path for finished evidence.
      const launched2 = await provider.launch({
        factory_run_id: 'run_factory_2',
        task,
        prompt: 'collect probe',
      });
      const run2 = sdk.runs.get(launched2.provider_run_id).run;
      run2.status = 'finished';
      const collected = await provider.collect({
        factory_run_id: 'run_factory_2',
        provider_run_id: launched2.provider_run_id,
        provider_agent_id: launched2.provider_agent_id,
        wait: true,
      });
      assert.equal(collected.provider_status, PROVIDER_STATUS.FINISHED);
      assert.equal(collected.evidence.result_text, 'fake worker output');
      assert.equal(Object.prototype.hasOwnProperty.call(collected, 'task_status'), false);
    });

    it('status trusts API getRun over stale in-memory handle error', async () => {
      // Regression for live run-1aaa834e: local handle briefly reported
      // status=error while cloud run continued to FINISHED with branch/PR.
      const sdk = new FakeCursorSdk();
      const provider = createCursorProvider({
        apiKey: 'test-key',
        sdkAdapter: fakeAdapter(sdk),
      });
      const launched = await provider.launch({
        factory_run_id: 'run_stale_handle',
        task: { task_id: 'task_stale_handle' },
        prompt: 'poisoned handle must not fail closed',
      });
      const authoritative = sdk.runs.get(launched.provider_run_id).run;
      authoritative.status = 'running';
      // Poison only the in-memory handle (diverges from API truth).
      provider._handles.get('run_stale_handle').run = {
        id: launched.provider_run_id,
        status: 'error',
        wait: async () => ({ status: 'error', result: 'stale handle error' }),
      };

      const before = sdk.getRunCalls.length;
      const status = await provider.status({
        factory_run_id: 'run_stale_handle',
        provider_run_id: launched.provider_run_id,
        provider_agent_id: launched.provider_agent_id,
      });
      assert.equal(sdk.getRunCalls.length, before + 1);
      assert.equal(status.provider_status, PROVIDER_STATUS.RUNNING);
      assert.equal(status.error, null);

      authoritative.status = 'finished';
      authoritative.result = 'done via API';
      authoritative.git = {
        branches: [
          {
            repoUrl: 'https://github.com/mac313248/jarvis-agencyos.git',
            branch: 'stage1-orch/smoke-regression',
            prUrl: 'https://github.com/mac313248/jarvis-agencyos/pull/999',
          },
        ],
      };
      const collected = await provider.collect({
        factory_run_id: 'run_stale_handle',
        provider_run_id: launched.provider_run_id,
        provider_agent_id: launched.provider_agent_id,
        wait: true,
      });
      assert.equal(collected.provider_status, PROVIDER_STATUS.FINISHED);
      assert.equal(collected.evidence.git.branch, 'stage1-orch/smoke-regression');
      assert.equal(collected.error, null);
    });

    it('preserves truthful auth/launch errors', async () => {
      const sdk = new FakeCursorSdk();
      sdk.failAuth = true;
      const provider = createCursorProvider({
        apiKey: 'bad-key',
        sdkAdapter: fakeAdapter(sdk),
      });
      const probe = await provider.probeAuth();
      assert.equal(probe.ok, false);
      assert.equal(probe.error.name, 'AuthenticationError');
      assert.match(probe.error.message, /Invalid User API Key/);

      await assert.rejects(
        () =>
          provider.launch({
            factory_run_id: 'run_x',
            task: { task_id: 'task_x' },
            prompt: 'x',
          }),
        (err) => err instanceof WorkerProviderError && err.code === 'AUTH_FAILED'
      );
    });

    it('createCursorSdkAdapter exposes official Agent/Cursor surface', () => {
      const adapter = createCursorSdkAdapter();
      assert.equal(typeof adapter.listModels, 'function');
      assert.equal(typeof adapter.createAgent, 'function');
      assert.equal(typeof adapter.getRun, 'function');
      assert.equal(typeof adapter.cancelRun, 'function');
    });
  });

  describe('Builder Core fencing around CursorProvider', () => {
    it('A–F: launch/status/cancel/collect + factory↔provider mapping + timeout/error', async () => {
      const sdk = new FakeCursorSdk();
      const provider = createCursorProvider({
        apiKey: 'test-key',
        sdkAdapter: fakeAdapter(sdk),
      });
      const core = createBuilderCore({ workerProvider: provider });
      const task = core.createAndLockTask(INTENT);

      const { run, provider_result } = await core.launchCodingWorker({
        task_id: task.task_id,
        prompt: 'lifecycle A',
      });
      assert.equal(run.provider, 'cursor');
      assert.equal(run.provider_run_id, provider_result.provider_run_id);
      assert.equal(run.provider_agent_id, provider_result.provider_agent_id);
      assert.ok(run.factory_run_id.startsWith('run_'));
      assert.equal(core.getTask(task.task_id).status, TASK_STATUS.RUNNING);

      const status = await core.refreshWorkerStatus(run.factory_run_id);
      assert.equal(status.provider_result.provider_status, PROVIDER_STATUS.RUNNING);
      assert.equal(status.run.factory_run_id, run.factory_run_id);

      const cancelled = await core.cancelCodingWorker(run.factory_run_id);
      assert.equal(cancelled.run.status, RUN_STATUS.CANCELLED);
      assert.equal(cancelled.provider_result.provider_status, PROVIDER_STATUS.CANCELLED);

      // Timeout / failure handling via provider observation.
      const task2 = core.createAndLockTask({
        ...INTENT,
        intent: 'timeout path',
      });
      const launched2 = await core.launchCodingWorker({
        task_id: task2.task_id,
        prompt: 'will timeout',
      });
      const timed = core.applyProviderResult(launched2.run.factory_run_id, {
        factory_run_id: launched2.run.factory_run_id,
        provider: 'cursor',
        provider_run_id: launched2.run.provider_run_id,
        provider_agent_id: launched2.run.provider_agent_id,
        provider_status: PROVIDER_STATUS.TIMEOUT,
        evidence: { reason: 'synthetic timeout' },
        error: {
          name: 'Timeout',
          message: 'worker exceeded budget',
          retryable: false,
          code: 'TIMEOUT',
        },
      });
      assert.equal(timed.run.status, RUN_STATUS.FAILED);
      assert.equal(timed.run.failure_class, FAILURE_CLASS.TIMEOUT);

      // Collect on a finished run does not mark task DONE/ACCEPTED.
      const task3 = core.createAndLockTask({
        ...INTENT,
        intent: 'collect path',
      });
      const launched3 = await core.launchCodingWorker({
        task_id: task3.task_id,
        prompt: 'collect',
      });
      sdk.runs.get(launched3.run.provider_run_id).run.status = 'finished';
      const collected = await core.collectCodingWorker(launched3.run.factory_run_id, {
        wait: true,
      });
      assert.equal(collected.provider_result.provider_status, PROVIDER_STATUS.FINISHED);
      assert.equal(collected.task_accepted, false);
      assert.notEqual(collected.task_status, TASK_STATUS.ACCEPTED);
      assert.notEqual(collected.task_status, 'DONE');
      core.close();
    });

    it('G: cancelled/stale run cannot become authoritative later', async () => {
      const sdk = new FakeCursorSdk();
      const provider = createCursorProvider({
        apiKey: 'test-key',
        sdkAdapter: fakeAdapter(sdk),
      });
      const core = createBuilderCore({ workerProvider: provider });
      const task = core.createAndLockTask(INTENT);
      const first = await core.launchCodingWorker({
        task_id: task.task_id,
        prompt: 'first',
      });
      await core.cancelCodingWorker(first.run.factory_run_id);

      assert.throws(
        () =>
          core.applyProviderResult(first.run.factory_run_id, {
            factory_run_id: first.run.factory_run_id,
            provider: 'cursor',
            provider_run_id: first.run.provider_run_id,
            provider_agent_id: first.run.provider_agent_id,
            provider_status: PROVIDER_STATUS.FINISHED,
            evidence: { late: true },
            error: null,
          }),
        (err) => err instanceof BuilderCoreError && err.code === 'STALE_RUN'
      );

      // New authorized run, then stale prior cannot record candidate.
      const second = await core.launchCodingWorker({
        task_id: task.task_id,
        prompt: 'second',
      });
      assert.throws(
        () =>
          core.recordCandidate({
            task_id: task.task_id,
            factory_run_id: first.run.factory_run_id,
            branch: 'evil',
            commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          }),
        (err) => err.code === 'STALE_RUN'
      );
      assert.ok(second.run.factory_run_id !== first.run.factory_run_id);
      const events = core.store.listEventsForTask(task.task_id);
      assert.ok(events.some((e) => e.event_type === EVENT_TYPE.STALE_RUN_REJECTED));
      core.close();
    });

    it('collect after cancel cannot revive a cancelled run', async () => {
      const sdk = new FakeCursorSdk();
      const provider = createCursorProvider({
        apiKey: 'test-key',
        sdkAdapter: fakeAdapter(sdk),
      });
      const core = createBuilderCore({ workerProvider: provider });
      const task = core.createAndLockTask(INTENT);
      const launched = await core.launchCodingWorker({
        task_id: task.task_id,
        prompt: 'cancel sticky',
      });
      await core.cancelCodingWorker(launched.run.factory_run_id);
      // Provider still reports running (eventual consistency).
      sdk.runs.get(launched.run.provider_run_id).run.status = 'running';
      const collected = await core.collectCodingWorker(launched.run.factory_run_id);
      assert.equal(collected.run.status, RUN_STATUS.CANCELLED);
      assert.equal(core.getCurrentCodingRun(), null);
      assert.equal(collected.task_accepted, false);
      core.close();
    });

    it('H: only one coding worker can be active', async () => {
      const sdk = new FakeCursorSdk();
      const provider = createCursorProvider({
        apiKey: 'test-key',
        sdkAdapter: fakeAdapter(sdk),
      });
      const core = createBuilderCore({ workerProvider: provider });
      const task = core.createAndLockTask(INTENT);
      await core.launchCodingWorker({ task_id: task.task_id, prompt: 'one' });
      await assert.rejects(
        () => core.launchCodingWorker({ task_id: task.task_id, prompt: 'two' }),
        (err) => err instanceof BuilderCoreError && err.code === 'ACTIVE_WORKER_EXISTS'
      );
      assert.equal(core.store.listActiveRuns().length, 1);
      core.close();
    });
  });

  describe('Live Cursor smoke (environment-limited)', () => {
    it('probes official SDK auth and does not invent success on invalid key', async () => {
      const provider = createCursorProvider();
      let probe;
      try {
        probe = await provider.probeAuth();
      } catch (err) {
        probe = {
          ok: false,
          error: {
            name: err.name,
            message: err.message,
            retryable: false,
            code: 'AUTH_UNAVAILABLE',
          },
        };
      }

      if (probe.ok) {
        // Live auth works: exercise launch→status→cancel against cloud.
        const core = createBuilderCore({ workerProvider: provider });
        const task = core.createAndLockTask({
          ...INTENT,
          intent: 'LIVE cursor lifecycle smoke — cancel immediately',
        });
        const { run, provider_result } = await core.launchCodingWorker({
          task_id: task.task_id,
          prompt:
            'Stage-1 Builder smoke: do not modify files. Reply with SMOKE_OK and stop.',
        });
        assert.ok(run.provider_run_id);
        assert.ok(run.provider_agent_id);
        assert.equal(provider_result.factory_run_id, run.factory_run_id);
        const st = await core.refreshWorkerStatus(run.factory_run_id);
        assert.ok(st.provider_result.provider_status);
        const cancelled = await core.cancelCodingWorker(run.factory_run_id);
        assert.equal(cancelled.provider_result.provider_status, PROVIDER_STATUS.CANCELLED);
        const collected = await core.collectCodingWorker(run.factory_run_id);
        assert.equal(collected.task_accepted, false);
        console.log(
          'LIVE_SMOKE factory_run_id=%s provider_run_id=%s provider_agent_id=%s',
          run.factory_run_id,
          run.provider_run_id,
          run.provider_agent_id
        );
        core.close();
      } else {
        // Proven live blocker: do not invent Cursor API success.
        assert.equal(probe.ok, false);
        assert.ok(probe.error?.message);
        console.log(
          'LIVE_SMOKE_BLOCKED code=%s name=%s message=%s',
          probe.error.code || 'AUTH_FAILED',
          probe.error.name,
          probe.error.message
        );
        assert.match(
          `${probe.error.name} ${probe.error.message}`,
          /Invalid User API Key|CURSOR_API_KEY unavailable|AuthenticationError|AUTH_/i
        );
      }
    });
  });
});
