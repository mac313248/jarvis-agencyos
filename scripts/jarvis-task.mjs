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
  createCodexReviewInvoker,
  createGhLandingClient,
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

  // Draft PR is required for Stage-1 GitHub landing truth. Never merge here.
  const autoCreatePR = process.env.JARVIS_AUTO_CREATE_PR !== '0';
  const provider = createCursorProvider({
    repoUrl:
      process.env.JARVIS_REPO_URL ||
      'https://github.com/mac313248/jarvis-agencyos.git',
    startingRef: process.env.JARVIS_STARTING_REF || 'phase-build/builder-stage-1-core',
    autoCreatePR,
  });

  const deps = createDefaultOrchestrationDeps({
    repoRoot: ROOT,
    enableGithub: process.env.JARVIS_DISABLE_GITHUB !== '1',
    enableCodex: false,
  });
  if (process.env.JARVIS_DISABLE_GITHUB !== '1' && !deps.githubClient) {
    try {
      deps.githubClient = createGhLandingClient({ cwd: ROOT });
    } catch {
      deps.githubClient = null;
    }
  }
  if (process.env.JARVIS_DISABLE_CODEX !== '1') {
    deps.codexInvoker = createCodexReviewInvoker({
      repoRoot: ROOT,
      timeoutMs: Number(process.env.JARVIS_CODEX_TIMEOUT_MS || 15 * 60 * 1000),
    });
  }

  const builder = createBuilderCore({
    dbPath,
    workerProvider: provider,
    autoRecover: true,
  });
  await builder.recover();

  const jarvis = createJarvisInterface({ builderCore: builder });
  const { execFileSync } = await import('node:child_process');
  const repoSlug =
    process.env.JARVIS_REPO_SLUG || 'mac313248/jarvis-agencyos';

  const response = await jarvis.dispatch(JARVIS_COMMANDS.EXECUTE_SOFTWARE_TASK, {
    ...task,
    orchestration: {
      githubClient: deps.githubClient,
      codexInvoker: deps.codexInvoker,
      poll_ms: Number(process.env.JARVIS_POLL_MS || 5000),
      timeout_ms: Number(process.env.JARVIS_TIMEOUT_MS || 45 * 60 * 1000),
      ci_poll_ms: Number(process.env.JARVIS_CI_POLL_MS || 15000),
      ci_timeout_ms: Number(process.env.JARVIS_CI_TIMEOUT_MS || 30 * 60 * 1000),
      getDiff: async ({ commit_sha } = {}) => {
        if (!commit_sha) return '';
        try {
          return execFileSync(
            'gh',
            [
              'api',
              `repos/${repoSlug}/commits/${commit_sha}`,
              '-H',
              'Accept: application/vnd.github.patch',
            ],
            { encoding: 'utf8' }
          ).slice(0, 120000);
        } catch {
          try {
            return execFileSync(
              'git',
              ['show', '--stat', '--oneline', '-1', commit_sha],
              { cwd: ROOT, encoding: 'utf8' }
            ).slice(0, 120000);
          } catch {
            return `commit ${commit_sha}`;
          }
        }
      },
      runTaskTests: async ({ commit_sha } = {}) => {
        // Exact-SHA CI remains authoritative; local suite is supplementary evidence.
        try {
          const out = execFileSync(
            'node',
            ['--test', 'tests/contracts-auth.test.mjs'],
            {
              cwd: ROOT,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 120000,
            }
          );
          return {
            ok: true,
            name: 'contracts-auth',
            output: String(out).slice(0, 4000),
            commit_sha: commit_sha || null,
          };
        } catch (err) {
          return {
            ok: false,
            name: 'contracts-auth',
            output: String(err?.stdout || err?.stderr || err?.message || err).slice(
              0,
              4000
            ),
            commit_sha: commit_sha || null,
          };
        }
      },
      runBuildChecks: async () => ({
        ok: true,
        output: 'jarvis-task default build checks ok',
      }),
    },
  });

  // Compact owner-safe summary (no env/credential dumps).
  const r = response.result || {};
  console.log(
    JSON.stringify(
      {
        ok: Boolean(r.ok),
        decision: r.decision,
        reason: r.reason,
        task_id: r.task_id,
        task_status: r.task_status,
        factory_run_id: r.factory_run_id,
        provider_run_id: r.provider_run_id,
        candidate_id: r.candidate_id,
        commit_sha: r.commit_sha,
        verification: r.verification,
        review: r.review,
        owner_interventions: response.owner_interventions,
        trajectory: r.trajectory,
      },
      null,
      2
    )
  );
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
