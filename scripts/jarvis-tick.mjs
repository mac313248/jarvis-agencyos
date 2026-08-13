#!/usr/bin/env node
// jarvis:tick — deterministic control-plane dispatcher.
// Does not enable the live Jarvis Builder Automation.
import { createBuilderCoreAsync, createCursorProvider, BUILDER_SQLITE_PATH_ENV } from '../src/builder/index.js';
import { runJarvisTick, TICK_TRIGGERS } from '../src/builder/tick.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    trigger: null,
    dispatch: true,
    persistEvidence: false,
    fakeProvider: false,
    db: process.env[BUILDER_SQLITE_PATH_ENV] || null,
    allowSqlite: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--trigger') {
      out.trigger = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--trigger=')) {
      out.trigger = arg.slice('--trigger='.length);
      continue;
    }
    if (arg === '--no-dispatch') {
      out.dispatch = false;
      continue;
    }
    if (arg === '--persist-evidence') {
      out.persistEvidence = true;
      continue;
    }
    if (arg === '--fake-provider') {
      out.fakeProvider = true;
      continue;
    }
    if (arg === '--db') {
      out.db = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--allow-sqlite') {
      out.allowSqlite = true;
      continue;
    }
  }
  return out;
}

function createFakeProvider() {
  return {
    name: 'cursor',
    async launch({ factory_run_id }) {
      return {
        factory_run_id,
        provider: 'cursor',
        provider_run_id: 'prov_fake_tick',
        provider_agent_id: 'bc-fake-tick',
        provider_status: 'LAUNCHED',
        evidence: { runtime: 'fake' },
        error: null,
      };
    },
    async status({ factory_run_id, provider_run_id, provider_agent_id }) {
      return {
        factory_run_id,
        provider: 'cursor',
        provider_run_id,
        provider_agent_id,
        provider_status: 'RUNNING',
        evidence: { runtime: 'fake' },
        error: null,
      };
    },
    async cancel({ factory_run_id, provider_run_id, provider_agent_id }) {
      return {
        factory_run_id,
        provider: 'cursor',
        provider_run_id,
        provider_agent_id,
        provider_status: 'CANCELLED',
        evidence: { runtime: 'fake' },
        error: null,
      };
    },
    async collect({ factory_run_id, provider_run_id, provider_agent_id }) {
      return {
        factory_run_id,
        provider: 'cursor',
        provider_run_id,
        provider_agent_id,
        provider_status: 'FINISHED',
        evidence: { runtime: 'fake' },
        error: null,
      };
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.trigger || !TICK_TRIGGERS.includes(opts.trigger)) {
    console.error('usage: npm run jarvis:tick -- --trigger <hourly|checks_failed|changes_requested|manual_smoke>');
    process.exitCode = 2;
    return;
  }

  const useFake = opts.fakeProvider || process.env.JARVIS_TICK_PROVIDER === 'fake';
  const provider = useFake
    ? createFakeProvider()
    : createCursorProvider({
        autoCreatePR: process.env.JARVIS_AUTO_CREATE_PR === '1',
      });

  const core = await createBuilderCoreAsync({
    dbPath: opts.db || undefined,
    allowSqlite: Boolean(opts.allowSqlite || opts.db),
    workerProvider: provider,
    autoRecover: true,
  });

  try {
    const decision = await runJarvisTick({
      root: process.cwd(),
      trigger: opts.trigger,
      core,
      dispatch: opts.dispatch,
      orientationOpts: {
        persistEvidence: opts.persistEvidence,
      },
    });
    console.log(JSON.stringify(decision, null, 2));
    if (decision.decision === 'BLOCKED') process.exitCode = 3;
    else if (decision.decision === 'NEEDS_OWNER') process.exitCode = 4;
    else process.exitCode = 0;
  } finally {
    core.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
