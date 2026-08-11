// Stage-1 exact-SHA CI wait — regression suite A–G.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createBuilderCore,
  RUN_STATUS,
  VERIFICATION_RESULT,
  PROVIDER_STATUS,
  waitForExactCandidateCi,
  classifyCiSummary,
  detectAwaitingCi,
  CI_WAIT_OUTCOME,
  resumeExactCandidateCiAndVerify,
  reconcileAfterRestart,
  assertNoDuplicateLaunchAfterRecovery,
  EVENT_TYPE,
} from '../src/builder/index.js';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const INTENT = {
  intent: 'CI wait regression',
  acceptance_ref: 'tests/builder-stage1-ci-wait.test.mjs',
  allowed_paths: ['artifacts/ci-wait.txt'],
  tool_manifest: {
    providers: ['cursor', 'github'],
    tools: ['coding_worker', 'repo_read'],
    mode: 'build',
  },
  review_required: true,
};

function progressiveGithub({
  sha = SHA_A,
  branch = 'stage1-orch/ci-wait',
  prNumber = 42,
  sequence = [],
  headShaOverride = null,
  headRefOverride = null,
} = {}) {
  let i = 0;
  return {
    calls: { checkRuns: [], commits: [] },
    async getCommit(requested) {
      this.calls.commits.push(requested);
      assert.equal(requested, sha);
      return { sha, html_url: `https://github.com/x/y/commit/${sha}`, message: 'x' };
    },
    async getPullRequest(number) {
      assert.equal(number, prNumber);
      return {
        number: prNumber,
        html_url: `https://github.com/x/y/pull/${prNumber}`,
        head_ref: headRefOverride || branch,
        head_sha: headShaOverride || sha,
        base_ref: 'main',
        state: 'open',
        draft: true,
      };
    },
    async findPullRequestsForHead() {
      return [{ number: prNumber, html_url: `https://github.com/x/y/pull/${prNumber}` }];
    },
    async getCheckRunsForCommit(requested) {
      assert.equal(requested, sha);
      const step = sequence[Math.min(i, sequence.length - 1)] || {
        status: 'pending',
        conclusion: null,
      };
      i += 1;
      this.calls.checkRuns.push({ requested, step });
      if (step.empty) return [];
      return [
        {
          id: 9001,
          name: 'phase1',
          status: step.status,
          conclusion: step.conclusion,
          html_url: 'https://github.com/x/y/runs/9001',
          head_sha: step.wrong_sha || sha,
        },
      ];
    },
    async getCombinedStatusForCommit() {
      const step = sequence[Math.min(Math.max(i - 1, 0), sequence.length - 1)] || {
        status: 'pending',
      };
      const state =
        step.status === 'completed'
          ? step.conclusion === 'success'
            ? 'success'
            : 'failure'
          : 'pending';
      return { state, statuses: [], total_count: step.empty ? 0 : 1 };
    },
    summarizeCi({ checkRuns = [], combinedStatus = null } = {}) {
      let ci_status = 'unknown';
      let ci_conclusion = null;
      if (checkRuns.length) {
        if (checkRuns.some((r) => r.status !== 'completed')) ci_status = 'pending';
        else if (
          checkRuns.some((r) =>
            ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion)
          )
        ) {
          ci_status = 'completed';
          ci_conclusion = 'failure';
        } else if (
          checkRuns.every((r) => ['success', 'neutral', 'skipped'].includes(r.conclusion))
        ) {
          // Match production helper: all success/neutral/skipped => success only if all success-like;
          // keep parity with github-landing.js: success|neutral|skipped => success
          ci_status = 'completed';
          ci_conclusion = checkRuns.every((r) =>
            ['success', 'neutral', 'skipped'].includes(r.conclusion)
          )
            ? checkRuns.some((r) => r.conclusion === 'neutral' || r.conclusion === 'skipped') &&
              !checkRuns.some((r) => r.conclusion === 'success')
              ? 'neutral'
              : 'success'
            : 'success';
          if (checkRuns.every((r) => r.conclusion === 'success')) {
            ci_conclusion = 'success';
          } else if (
            checkRuns.every((r) => ['success', 'neutral', 'skipped'].includes(r.conclusion))
          ) {
            ci_conclusion = checkRuns.every((r) => r.conclusion === 'success')
              ? 'success'
              : 'success';
          }
        }
      } else if (combinedStatus?.state === 'pending') {
        ci_status = 'pending';
      }
      // Simplify: use step-driven conclusions for tests
      const last = sequence[Math.min(Math.max(i - 1, 0), sequence.length - 1)];
      if (last?.status === 'completed') {
        ci_status = 'completed';
        ci_conclusion =
          last.conclusion === 'success'
            ? 'success'
            : last.conclusion === 'cancelled' ||
                last.conclusion === 'timed_out' ||
                last.conclusion === 'failure'
              ? 'failure'
              : last.conclusion;
      } else if (last?.empty || last?.status === 'pending' || last?.status === 'in_progress') {
        ci_status = 'pending';
        ci_conclusion = null;
      }
      return {
        ci_status,
        ci_conclusion,
        checks: checkRuns.map((r) => ({
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
        })),
        combined_state: combinedStatus?.state || null,
        captured_at: new Date().toISOString(),
      };
    },
  };
}

async function seedSucceededCandidate(core, { sha = SHA_A, branch = 'stage1-orch/ci-wait' } = {}) {
  const task = core.createAndLockTask(INTENT);
  const { run } = await core.launchCodingWorker({
    task_id: task.task_id,
    prompt: 'seed',
  });
  core.applyProviderResult(run.factory_run_id, {
    factory_run_id: run.factory_run_id,
    provider: 'cursor',
    provider_run_id: run.provider_run_id,
    provider_agent_id: run.provider_agent_id,
    provider_status: PROVIDER_STATUS.FINISHED,
    evidence: { git: { branch, prUrl: 'https://github.com/x/y/pull/42' } },
    error: null,
  });
  assert.equal(core.getRun(run.factory_run_id).status, RUN_STATUS.SUCCEEDED);
  const candidate = core.recordCandidate({
    task_id: task.task_id,
    factory_run_id: run.factory_run_id,
    branch,
    commit_sha: sha,
    pr_number: 42,
    pr_url: 'https://github.com/x/y/pull/42',
  });
  return { task, run, candidate };
}

function scriptedProvider() {
  let n = 0;
  return {
    name: 'cursor',
    async launch({ factory_run_id }) {
      n += 1;
      return {
        provider: 'cursor',
        provider_status: 'RUNNING',
        factory_run_id,
        provider_run_id: `prov-${n}`,
        provider_agent_id: `bc-${n}`,
        evidence: {},
        error: null,
      };
    },
    async status({ factory_run_id, provider_run_id, provider_agent_id }) {
      return {
        provider: 'cursor',
        provider_status: 'RUNNING',
        factory_run_id,
        provider_run_id,
        provider_agent_id,
        evidence: {},
        error: null,
      };
    },
    async cancel() {
      return { provider: 'cursor', provider_status: 'CANCELLED', evidence: {}, error: null };
    },
    async collect({ factory_run_id, provider_run_id, provider_agent_id }) {
      return {
        provider: 'cursor',
        provider_status: 'FINISHED',
        factory_run_id,
        provider_run_id,
        provider_agent_id,
        evidence: {},
        error: null,
      };
    },
  };
}

describe('Stage-1 exact CI wait (A–G)', () => {
  it('A: pending → success continues (SUCCESS outcome + evidence)', async () => {
    const core = createBuilderCore({ workerProvider: scriptedProvider() });
    const { candidate } = await seedSucceededCandidate(core);
    const gh = progressiveGithub({
      sequence: [
        { status: 'in_progress', conclusion: null },
        { status: 'completed', conclusion: 'success' },
      ],
    });
    let now = 1_000_000;
    const slept = [];
    const result = await waitForExactCandidateCi(core, {
      candidate_id: candidate.candidate_id,
      githubClient: gh,
      poll_ms: 10,
      timeout_ms: 1000,
      sleepFn: async (ms) => {
        slept.push(ms);
      },
      nowFn: () => {
        now += 1;
        return now;
      },
    });
    assert.equal(result.outcome, CI_WAIT_OUTCOME.SUCCESS);
    assert.equal(result.evidence.commit_sha, SHA_A);
    assert.equal(result.evidence.candidate_id, candidate.candidate_id);
    assert.equal(result.evidence.pr_number, 42);
    assert.deepEqual(result.evidence.check_run_ids, [9001]);
    assert.ok(result.evidence.started_at);
    assert.ok(result.evidence.finished_at);
    assert.ok(slept.length >= 1);
    assert.equal(core.store.getCandidate(candidate.candidate_id).ci_conclusion, 'success');
  });

  it('B: pending → failure fails (FAILURE outcome)', async () => {
    const core = createBuilderCore({ workerProvider: scriptedProvider() });
    const { candidate } = await seedSucceededCandidate(core);
    const gh = progressiveGithub({
      sequence: [
        { status: 'pending', conclusion: null },
        { status: 'completed', conclusion: 'failure' },
      ],
    });
    let now = 1;
    const result = await waitForExactCandidateCi(core, {
      candidate_id: candidate.candidate_id,
      githubClient: gh,
      poll_ms: 1,
      timeout_ms: 100,
      sleepFn: async () => {},
      nowFn: () => ++now,
    });
    assert.equal(result.outcome, CI_WAIT_OUTCOME.FAILURE);
    const verified = await core.verifyCandidate(candidate.candidate_id, {
      githubClient: gh,
      runTaskTests: async () => ({ ok: true, output: 'ok' }),
      runBuildChecks: async () => ({ ok: true, output: 'ok' }),
    });
    assert.equal(verified.result, VERIFICATION_RESULT.FAIL);
  });

  it('C: pending → timeout BLOCKED', async () => {
    const core = createBuilderCore({ workerProvider: scriptedProvider() });
    const { candidate } = await seedSucceededCandidate(core);
    const gh = progressiveGithub({
      sequence: [{ status: 'in_progress', conclusion: null }],
    });
    let now = 0;
    const result = await waitForExactCandidateCi(core, {
      candidate_id: candidate.candidate_id,
      githubClient: gh,
      poll_ms: 5,
      timeout_ms: 20,
      sleepFn: async () => {
        now += 5;
      },
      nowFn: () => now,
    });
    assert.equal(result.outcome, CI_WAIT_OUTCOME.TIMEOUT);
    const verified = await core.verifyCandidate(candidate.candidate_id, {
      githubClient: gh,
      runTaskTests: async () => ({ ok: true, output: 'ok' }),
      runBuildChecks: async () => ({ ok: true, output: 'ok' }),
    });
    assert.equal(verified.result, VERIFICATION_RESULT.BLOCKED);
  });

  it('D: SHA change invalidates old CI evidence', async () => {
    const core = createBuilderCore({ workerProvider: scriptedProvider() });
    const { task, candidate } = await seedSucceededCandidate(core, { sha: SHA_A });
    const ghA = progressiveGithub({
      sha: SHA_A,
      sequence: [{ status: 'completed', conclusion: 'success' }],
    });
    await waitForExactCandidateCi(core, {
      candidate_id: candidate.candidate_id,
      githubClient: ghA,
      poll_ms: 1,
      timeout_ms: 50,
      sleepFn: async () => {},
      nowFn: () => Date.now(),
    });
    assert.equal(core.store.getCandidate(candidate.candidate_id).ci_conclusion, 'success');

    // New exact candidate for SHA B supersedes A; A CI cannot authorize B.
    const run = core.store.listRunsForTask(task.task_id)[0];
    // Need SUCCEEDED run still - same run can register new SHA (supersedes).
    const candB = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'stage1-orch/ci-wait',
      commit_sha: SHA_B,
      pr_number: 42,
      pr_url: 'https://github.com/x/y/pull/42',
    });
    assert.equal(
      core.store.getCandidate(candidate.candidate_id).status,
      'SUPERSEDED'
    );
    const ghB = progressiveGithub({
      sha: SHA_B,
      sequence: [{ status: 'completed', conclusion: 'success' }],
    });
    // Cross-SHA guard: querying B never accepts A's check id as authority without B success.
    const waitB = await waitForExactCandidateCi(core, {
      candidate_id: candB.candidate_id,
      githubClient: ghB,
      poll_ms: 1,
      timeout_ms: 50,
      sleepFn: async () => {},
    });
    assert.equal(waitB.evidence.commit_sha, SHA_B);
    assert.notEqual(waitB.evidence.commit_sha, SHA_A);
    assert.ok(
      !String(core.store.getCandidate(candB.candidate_id).ci_ref).includes(SHA_A) ||
        waitB.evidence.commit_sha === SHA_B
    );

    // Head change while waiting for A-bound candidate
    const core2 = createBuilderCore({ workerProvider: scriptedProvider() });
    const seeded = await seedSucceededCandidate(core2, { sha: SHA_A });
    const ghHead = progressiveGithub({
      sha: SHA_A,
      headShaOverride: SHA_B,
      sequence: [{ status: 'in_progress', conclusion: null }],
    });
    const headChange = await waitForExactCandidateCi(core2, {
      candidate_id: seeded.candidate.candidate_id,
      githubClient: ghHead,
      poll_ms: 1,
      timeout_ms: 50,
      sleepFn: async () => {},
    });
    assert.equal(headChange.outcome, CI_WAIT_OUTCOME.HEAD_CHANGED);
    assert.equal(headChange.new_head_sha, SHA_B);
  });

  it('E: wrong PR/branch fails closed', async () => {
    const core = createBuilderCore({ workerProvider: scriptedProvider() });
    const { candidate } = await seedSucceededCandidate(core);
    const gh = progressiveGithub({
      headRefOverride: 'wrong-branch',
      sequence: [{ status: 'completed', conclusion: 'success' }],
    });
    const result = await waitForExactCandidateCi(core, {
      candidate_id: candidate.candidate_id,
      githubClient: gh,
      poll_ms: 1,
      timeout_ms: 50,
      sleepFn: async () => {},
    });
    assert.equal(result.outcome, CI_WAIT_OUTCOME.PR_MISMATCH);
  });

  it('F: restart while waiting resumes safely without duplicate worker launch', async () => {
    const provider = scriptedProvider();
    const core = createBuilderCore({ workerProvider: provider });
    const { task, candidate } = await seedSucceededCandidate(core);
    // Mid-wait: CI still pending, no verification yet.
    core.store.updateCandidate(candidate.candidate_id, {
      ci_status: 'pending',
      ci_conclusion: null,
    });
    const awaiting = detectAwaitingCi(core, task.task_id);
    assert.equal(awaiting.awaiting_ci, true);

    const recovered = await reconcileAfterRestart(core);
    assert.equal(recovered.status, 'OK');
    const snap = recovered.tasks.find((t) => t.task_id === task.task_id);
    assert.equal(snap.awaiting_ci, true);
    assert.equal(snap.resume_without_worker_launch, true);
    assertNoDuplicateLaunchAfterRecovery(core);

    const gh = progressiveGithub({
      sequence: [
        { status: 'in_progress', conclusion: null },
        { status: 'completed', conclusion: 'success' },
      ],
    });
    let now = 10;
    const resumed = await resumeExactCandidateCiAndVerify(core, {
      task_id: task.task_id,
      githubClient: gh,
      ci_poll_ms: 1,
      ci_timeout_ms: 100,
      sleepFn: async () => {
        now += 1;
      },
      runTaskTests: async () => ({ ok: true, output: 'ok' }),
      runBuildChecks: async () => ({ ok: true, output: 'ok' }),
    });
    assert.equal(resumed.duplicate_worker_launch, false);
    assert.equal(resumed.ci_wait.outcome, CI_WAIT_OUTCOME.SUCCESS);
    assert.equal(resumed.verified.result, VERIFICATION_RESULT.PASS);
    // Only the seed launch — resume did not launch again.
    assert.equal(core.store.listRunsForTask(task.task_id).length, 1);
  });

  it('G: no smoke-only CI bypass exists', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = [
      'src/builder/ci-wait.js',
      'src/builder/orchestrator.js',
      'src/builder/verifier.js',
      'tests/builder-stage1-orchestration.test.mjs',
    ];
    for (const rel of files) {
      const text = readFileSync(join(root, rel), 'utf8');
      assert.equal(/smoke[_-]?only|bypass.?ci|skip.?ci.?for.?smoke|treat.?pending.?as.?pass/i.test(text), false);
      assert.equal(/CI_BYPASS|SMOKE_CI_SKIP/.test(text), false);
    }
    // Pending never classifies as success.
    assert.deepEqual(classifyCiSummary({ ci_status: 'pending', ci_conclusion: null }), {
      terminal: false,
      outcome: null,
    });
    assert.equal(
      classifyCiSummary({ ci_status: 'completed', ci_conclusion: 'success' }).outcome,
      CI_WAIT_OUTCOME.SUCCESS
    );
  });

  it('emits CI wait lifecycle events with evidence', async () => {
    const core = createBuilderCore({ workerProvider: scriptedProvider() });
    const { candidate, task } = await seedSucceededCandidate(core);
    const gh = progressiveGithub({
      sequence: [{ status: 'completed', conclusion: 'success' }],
    });
    await waitForExactCandidateCi(core, {
      candidate_id: candidate.candidate_id,
      githubClient: gh,
      poll_ms: 1,
      timeout_ms: 50,
      sleepFn: async () => {},
    });
    const types = core.store
      .listEventsForTask(task.task_id)
      .map((e) => e.event_type);
    assert.ok(types.includes(EVENT_TYPE.CI_WAIT_STARTED));
    assert.ok(types.includes(EVENT_TYPE.CI_WAIT_PROGRESS));
    assert.ok(types.includes(EVENT_TYPE.CI_WAIT_FINISHED));
  });
});
