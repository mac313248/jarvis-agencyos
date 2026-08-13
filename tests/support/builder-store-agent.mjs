#!/usr/bin/env node
// Isolated Builder agent process for shared-store tests.
// Simulates a fresh Cursor Cloud VM talking only to the shared Builder store.

import { existsSync } from 'node:fs';
import {
  APPROVAL_STATUS,
  BUILDER_DATABASE_URL_ENV,
  CANDIDATE_STATUS,
  REVIEW_STATUS,
  RUN_STATUS,
  VERIFICATION_RESULT,
  createBuilderCoreAsync,
} from '../../src/builder/index.js';
import { createJarvisInterface, JARVIS_COMMANDS } from '../../src/jarvis/index.js';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TASK_ID = 'task_shared_store_cross_agent';

function parseArgs(argv) {
  const out = { mode: argv[2], databaseUrl: null, root: process.cwd() };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--database-url') {
      out.databaseUrl = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--root') {
      out.root = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function snapshot(core) {
  const reconstructed = core.reconstruct();
  const task = core.getTask(TASK_ID);
  const runs = task ? core.store.listRunsForTask(task.task_id) : [];
  const candidates = task ? core.store.listCandidatesForTask(task.task_id) : [];
  const candidate = candidates[0] || null;
  const verification = candidate?.verification_ref
    ? core.store.getVerification(candidate.verification_ref)
    : null;
  const review = candidate?.review_ref
    ? core.store.getReview(candidate.review_ref)
    : null;
  return {
    schema_version: reconstructed.schema_version,
    store_backend: reconstructed.store_backend || core.store.kind,
    task_id: task?.task_id || null,
    task_status: task?.status || null,
    factory_run_id: runs[0]?.factory_run_id || null,
    run_status: runs[0]?.status || null,
    provider_run_id: runs[0]?.provider_run_id || null,
    candidate_id: candidate?.candidate_id || null,
    commit_sha: candidate?.commit_sha || null,
    verification_id: verification?.verification_id || null,
    verification_result: verification?.result || null,
    review_id: review?.review_id || null,
    review_status: review?.review_status || null,
    current_factory_run_id: reconstructed.current_factory_run_id,
    nonterminal_task_ids: (reconstructed.nonterminal_tasks || []).map((t) => t.task_id),
    task_count: core.store.listTasks().length,
    local_sqlite_present: existsSync('.data/builder/jarvis-tasks.sqlite'),
  };
}

async function persist(core) {
  const task = core.createAndLockTask({
    task_id: TASK_ID,
    intent: 'Shared Builder store cross-agent reconstruct',
    acceptance_ref: 'tests/builder-shared-store.test.mjs',
    allowed_paths: ['src/builder/', 'tests/builder-shared-store.test.mjs'],
    tool_manifest: { providers: ['cursor'], tools: ['coding_worker'], mode: 'build' },
    review_required: true,
  });
  const run = core.createRun({
    task_id: task.task_id,
    provider: 'cursor',
    provider_run_id: 'prov_shared_store_1',
    provider_agent_id: 'bc-shared-store-1',
  });
  core.store.updateRun(run.factory_run_id, {
    status: RUN_STATUS.RUNNING,
    started_at: new Date().toISOString(),
  });
  core._currentFactoryRunId = run.factory_run_id;
  const candidate = core.recordCandidate({
    task_id: task.task_id,
    factory_run_id: run.factory_run_id,
    branch: 'cursor/builder-shared-store-test',
    commit_sha: SHA,
    pr_number: 99,
    pr_url: 'https://github.com/mac313248/jarvis-agencyos/pull/99',
  });
  const verification = core.store.insertVerification({
    verification_id: 'ver_shared_store_1',
    candidate_id: candidate.candidate_id,
    commit_sha: SHA,
    result: VERIFICATION_RESULT.PASS,
    checks: [{ name: 'exact_sha', ok: true, authoritative: true }],
    worker_claim: 'worker self-cert must be ignored',
  });
  core.store.updateCandidate(candidate.candidate_id, {
    verification_ref: verification.verification_id,
    status: CANDIDATE_STATUS.VERIFIED,
  });
  const review = core.store.insertReview({
    review_id: 'rev_shared_store_1',
    candidate_id: candidate.candidate_id,
    commit_sha: SHA,
    review_status: REVIEW_STATUS.PASS,
    findings: [],
    evidence: { reviewer: 'codex' },
  });
  core.store.updateCandidate(candidate.candidate_id, {
    review_ref: review.review_id,
  });
  core.recordApproval({
    task_id: task.task_id,
    approved_by: 'owner',
    candidate_id: candidate.candidate_id,
    commit_sha: SHA,
    status: APPROVAL_STATUS.APPROVED,
  });
  return snapshot(core);
}

async function reconstruct(core) {
  const jarvis = createJarvisInterface({ builderCore: core });
  const official = jarvis.dispatch(JARVIS_COMMANDS.RECONSTRUCT);
  const snap = snapshot(core);
  snap.official_reconstruct_delegated_to = official.delegated_to;
  snap.official_nonterminal_ids = (official.result.nonterminal_tasks || []).map(
    (t) => t.task_id
  );
  snap.handoff_factory_run_id = official.result.current_factory_run_id;
  snap.duplicate_task_created = official.result.nonterminal_tasks.length > 1;
  return snap;
}

async function duplicateClaim(core) {
  try {
    core.createAndLockTask({
      task_id: TASK_ID,
      intent: 'duplicate claim must be rejected',
      acceptance_ref: 'tests/builder-shared-store.test.mjs',
      allowed_paths: ['src/builder/'],
      tool_manifest: { providers: ['cursor'], tools: ['coding_worker'], mode: 'build' },
    });
    return { duplicate_rejected: false, task_count: core.store.listTasks().length };
  } catch (err) {
    return {
      duplicate_rejected: err.code === 'DUPLICATE_CLAIM',
      code: err.code,
      task_count: core.store.listTasks().length,
    };
  }
}

async function staleFence(core) {
  const task = core.getTask(TASK_ID);
  const run = core.store.listRunsForTask(task.task_id)[0];
  core.markRunStale(run.factory_run_id);
  let stale_update_rejected = false;
  try {
    core.store.updateRun(run.factory_run_id, { status: RUN_STATUS.RUNNING });
  } catch (err) {
    stale_update_rejected = err.code === 'STALE_RUN';
  }
  let stale_apply_rejected = false;
  try {
    core.applyProviderResult(run.factory_run_id, {
      factory_run_id: run.factory_run_id,
      provider: 'cursor',
      provider_status: 'FINISHED',
      evidence: {},
    });
  } catch (err) {
    stale_apply_rejected = err.code === 'STALE_RUN';
  }
  return {
    run_status: core.getRun(run.factory_run_id).status,
    stale_update_rejected,
    stale_apply_rejected,
    current_factory_run_id: core.reconstruct().current_factory_run_id,
  };
}

async function leaseClaim(core, owner) {
  const lease = core.store.tryAcquireLease('jarvis-tick', owner);
  return {
    acquired: Boolean(lease),
    owner: lease?.owner || null,
    fencing_token: lease?.fencing_token || null,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.databaseUrl) {
    process.stderr.write('missing --database-url\n');
    process.exit(2);
  }
  if (existsSync('.data/builder/jarvis-tasks.sqlite')) {
    process.stderr.write('local sqlite must not exist in fresh agent\n');
    process.exit(3);
  }
  const core = await createBuilderCoreAsync({
    databaseUrl: opts.databaseUrl,
    autoRecover: true,
  });
  try {
    let result;
    switch (opts.mode) {
      case 'persist':
        result = await persist(core);
        break;
      case 'reconstruct':
        result = await reconstruct(core);
        break;
      case 'duplicate-claim':
        result = await duplicateClaim(core);
        break;
      case 'stale-fence':
        result = await staleFence(core);
        break;
      case 'lease-claim':
        result = await leaseClaim(core, process.argv.includes('--owner')
          ? process.argv[process.argv.indexOf('--owner') + 1]
          : String(process.pid));
        break;
      default:
        process.stderr.write(`unknown mode: ${opts.mode}\n`);
        process.exit(2);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    core.close();
  }
}

void main();
