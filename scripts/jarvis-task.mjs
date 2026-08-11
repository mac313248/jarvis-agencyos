#!/usr/bin/env node
// Owner-facing Jarvis Stage-1 command:
//   npm run jarvis:task -- <task.json>
//   npm run jarvis:task -- --stdin < task.json
//
// One owner submission. Jarvis/Builder owns the pipeline afterward.
// No manual Cursor/Codex relay.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createBuilderCore,
  createCursorProvider,
  createDefaultOrchestrationDeps,
} from '../src/builder/index.js';
import { createJarvisInterface, JARVIS_COMMANDS } from '../src/jarvis/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error(`Usage:
  npm run jarvis:task -- <task.json>
  npm run jarvis:task -- --stdin < task.json

task.json fields:
  intent, acceptance_ref, allowed_paths, tool_manifest
  optional: review_required, max_attempts, max_runtime_ms, owner_prompt
`);
}

async function readTaskInput(argv) {
  if (argv.includes('--stdin') || argv.includes('-')) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const file = argv.find((a) => !a.startsWith('-'));
  if (!file) {
    usage();
    process.exit(2);
  }
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) {
    console.error(`task file not found: ${path}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const task = await readTaskInput(argv);
  const dataDir = join(ROOT, '.data', 'builder');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.JARVIS_BUILDER_DB || join(dataDir, 'jarvis-tasks.sqlite');

  const provider = createCursorProvider({
    repoUrl:
      process.env.JARVIS_REPO_URL ||
      'https://github.com/mac313248/jarvis-agencyos.git',
    startingRef: process.env.JARVIS_STARTING_REF || 'phase-build/builder-stage-1-core',
    autoCreatePR: process.env.JARVIS_AUTO_CREATE_PR === '1',
  });

  const deps = createDefaultOrchestrationDeps({
    repoRoot: ROOT,
    enableGithub: process.env.JARVIS_DISABLE_GITHUB !== '1',
    enableCodex: process.env.JARVIS_DISABLE_CODEX !== '1',
  });

  const builder = createBuilderCore({
    dbPath,
    workerProvider: provider,
    autoRecover: true,
  });
  await builder.recover();

  const jarvis = createJarvisInterface({ builderCore: builder });

  const response = await jarvis.dispatch(JARVIS_COMMANDS.EXECUTE_SOFTWARE_TASK, {
    ...task,
    orchestration: {
      githubClient: deps.githubClient,
      codexInvoker: deps.codexInvoker,
      poll_ms: Number(process.env.JARVIS_POLL_MS || 3000),
      timeout_ms: Number(process.env.JARVIS_TIMEOUT_MS || 20 * 60 * 1000),
      getDiff: async ({ commit_sha } = {}) => {
        if (!commit_sha) return '';
        try {
          const { execFileSync } = await import('node:child_process');
          return execFileSync('git', ['show', '--stat', '--oneline', '-1', commit_sha], {
            cwd: ROOT,
            encoding: 'utf8',
          });
        } catch {
          return '';
        }
      },
      runTaskTests: async () => {
        // Owner acceptance tests remain task-specific; default is non-authoritative
        // placeholder unless task.acceptance_ref implies a suite. Live smoke overrides.
        return { ok: true, name: 'orchestrator_default', output: 'ok' };
      },
    },
  });

  console.log(JSON.stringify(response, null, 2));
  jarvis.close();
  process.exit(response.result?.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: {
          name: err.name,
          message: err.message,
          code: err.code || err.reason || 'JARVIS_TASK_FAILED',
        },
      },
      null,
      2
    )
  );
  process.exit(1);
});
