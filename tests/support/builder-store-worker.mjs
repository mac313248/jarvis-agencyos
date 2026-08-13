#!/usr/bin/env node
// Child-process helper for Builder store race / reconstruction tests.
import { openPostgresBuilderStore } from '../../src/builder/store-postgres.js';
import { createBuilderCore } from '../../src/builder/index.js';
import { runJarvisTick } from '../../src/builder/tick.js';

const [mode, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson || '{}');

function fakeProvider(id) {
  return {
    name: 'cursor',
    async launch({ factory_run_id }) {
      return {
        factory_run_id,
        provider: 'cursor',
        provider_run_id: 'prov_' + id,
        provider_agent_id: 'bc-' + id,
        provider_status: 'LAUNCHED',
        evidence: { runtime: 'fake', worker: id },
        error: null,
      };
    },
    async status(args) {
      return { ...args, provider: 'cursor', provider_status: 'RUNNING', evidence: {}, error: null };
    },
    async cancel(args) {
      return { ...args, provider: 'cursor', provider_status: 'CANCELLED', evidence: {}, error: null };
    },
    async collect(args) {
      return { ...args, provider: 'cursor', provider_status: 'FINISHED', evidence: {}, error: null };
    },
  };
}

async function main() {
  const store = await openPostgresBuilderStore(payload.databaseUrl);
  try {
    if (mode === 'claim') {
      const result = await store.claimLogicalWork(payload.work);
      process.stdout.write(JSON.stringify({
        claimed: result.claimed,
        task_id: result.task?.task_id || null,
        reason: result.reason || null,
      }));
      return;
    }
    if (mode === 'insert-run') {
      const result = await store.tryInsertActiveRun({
        task_id: payload.task_id,
        provider: 'cursor',
        owner: payload.owner,
      });
      process.stdout.write(JSON.stringify({
        inserted: result.inserted,
        factory_run_id: result.run?.factory_run_id || null,
        reason: result.reason || null,
      }));
      return;
    }
    if (mode === 'tick') {
      const core = createBuilderCore({
        store,
        workerProvider: fakeProvider(payload.owner || String(process.pid)),
        autoRecover: false,
      });
      process.env.CURSOR_CLOUD_AGENT_ID = payload.owner || ('worker-' + process.pid);
      const decision = await runJarvisTick({
        root: payload.root,
        trigger: payload.trigger || 'manual_smoke',
        core,
        dispatch: Boolean(payload.dispatch),
        persist: false,
        catalog: payload.catalog,
        orientation: payload.orientation,
      });
      process.stdout.write(JSON.stringify({
        decision: decision.decision,
        reason: decision.reason,
        task_id: decision.task_id,
        factory_run_id: decision.factory_run_id,
        provider_run_id: decision.provider_run_id,
        dispatched: decision.dispatched,
      }));
      return;
    }
    throw new Error('unknown mode: ' + mode);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack || err));
  process.exit(1);
});
