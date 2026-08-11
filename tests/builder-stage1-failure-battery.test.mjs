// Stage-1 Build Order item 17 — FULL FAILURE BATTERY.
// Deliberately injects failures and proves Builder Core fails closed.
// Uses deterministic/fake providers; no destructive live side effects.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBuilderCore,
  TASK_STATUS,
  RUN_STATUS,
  CANDIDATE_STATUS,
  APPROVAL_STATUS,
  EVENT_TYPE,
  FAILURE_CLASS,
  VERIFICATION_RESULT,
  REVIEW_STATUS,
  PROVIDER_STATUS,
  ToolPolicyError,
  assertNoBusinessCredentials,
  WorkerProviderError,
} from '../src/builder/index.js';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const INTENT = {
  intent: 'Stage-1 failure battery',
  acceptance_ref: 'tests/builder-stage1-failure-battery.test.mjs',
  allowed_paths: ['src/builder/', 'tests/builder-stage1-failure-battery.test.mjs'],
  tool_manifest: {
    providers: ['cursor', 'github', 'web_search'],
    tools: ['coding_worker', 'repo_read', 'research'],
    mode: 'build',
  },
  review_required: true,
  max_attempts: 2,
};

function recordBattery({
  test_id,
  initial_state,
  injected_failure,
  expected,
  actual,
  evidence,
  pass,
}) {
  const row = {
    test_id,
    initial_state,
    injected_failure,
    expected_result: expected,
    actual_result: actual,
    evidence,
    result: pass ? 'PASS' : 'FAIL',
  };
  console.log('FAILURE_BATTERY %s', JSON.stringify(row));
  assert.equal(pass, true, `${test_id} failed: ${JSON.stringify(row)}`);
  return row;
}

function fakeGithub({
  sha = SHA_A,
  branch = 'stage1-smoke/failure-battery',
  prNumber = 12,
  prUrl = 'https://github.com/mac313248/jarvis-agencyos/pull/12',
  ciConclusion = 'success',
  ciStatus = 'completed',
} = {}) {
  return {
    async getCommit(requested) {
      assert.equal(requested, sha);
      return { sha, html_url: `https://github.com/x/y/commit/${sha}`, message: 'demo' };
    },
    async getPullRequest(number) {
      assert.equal(number, prNumber);
      return {
        number: prNumber,
        html_url: prUrl,
        head_ref: branch,
        head_sha: sha,
        base_ref: 'main',
        state: 'open',
        draft: true,
      };
    },
    async findPullRequestsForHead(head) {
      assert.equal(head, branch);
      return [{ number: prNumber, html_url: prUrl, state: 'open', title: 'demo' }];
    },
    async getCheckRunsForCommit(requested) {
      assert.equal(requested, sha);
      return [
        {
          id: 1,
          name: 'phase1',
          status: ciStatus === 'pending' ? 'in_progress' : 'completed',
          conclusion: ciStatus === 'pending' ? null : ciConclusion,
          html_url: prUrl,
        },
      ];
    },
    async getCombinedStatusForCommit() {
      return {
        state:
          ciConclusion === 'success'
            ? 'success'
            : ciConclusion === 'failure'
              ? 'failure'
              : 'pending',
        statuses: [],
        total_count: 1,
      };
    },
    summarizeCi({ checkRuns = [], combinedStatus = null } = {}) {
      return {
        ci_status: ciStatus,
        ci_conclusion: ciConclusion,
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

function crashyProvider({ launches = [], mode = 'crash-on-status' } = {}) {
  const handles = new Map();
  return {
    name: 'cursor',
    async launch({ factory_run_id, allowed_tool_manifest }) {
      launches.push({ factory_run_id, allowed_tool_manifest });
      const provider_run_id = `prov-${launches.length}`;
      const provider_agent_id = `bc-${launches.length}`;
      handles.set(factory_run_id, {
        provider_run_id,
        provider_agent_id,
        status: PROVIDER_STATUS.RUNNING,
        evidence: { launched: true, crash_mode: mode },
      });
      return {
        provider: 'cursor',
        provider_status: PROVIDER_STATUS.RUNNING,
        factory_run_id,
        provider_run_id,
        provider_agent_id,
        evidence: { launched: true },
      };
    },
    async status({ factory_run_id }) {
      const h = handles.get(factory_run_id);
      if (!h) throw new WorkerProviderError('unknown run', { code: 'UNKNOWN_RUN' });
      if (mode === 'crash-on-status') {
        h.status = PROVIDER_STATUS.ERROR;
        h.evidence = { ...(h.evidence || {}), crashed: true, at: 'mid-run' };
      }
      return {
        provider: 'cursor',
        provider_status: h.status,
        factory_run_id,
        provider_run_id: h.provider_run_id,
        provider_agent_id: h.provider_agent_id,
        evidence: h.evidence,
        error:
          h.status === PROVIDER_STATUS.ERROR
            ? { code: 'WORKER_CRASH', message: 'worker terminated mid-run', retryable: true }
            : null,
      };
    },
    async cancel({ factory_run_id }) {
      const h = handles.get(factory_run_id);
      h.status = PROVIDER_STATUS.CANCELLED;
      return {
        provider: 'cursor',
        provider_status: PROVIDER_STATUS.CANCELLED,
        factory_run_id,
        provider_run_id: h.provider_run_id,
        provider_agent_id: h.provider_agent_id,
        evidence: { ...(h.evidence || {}), cancelled: true },
      };
    },
    async collect({ factory_run_id }) {
      const h = handles.get(factory_run_id);
      return {
        provider: 'cursor',
        provider_status: h.status,
        factory_run_id,
        provider_run_id: h.provider_run_id,
        provider_agent_id: h.provider_agent_id,
        evidence: h.evidence,
        artifacts: {},
      };
    },
    _handles: handles,
  };
}

function seedActiveRun(core, { sha = SHA_A, branch = 'stage1-smoke/failure-battery' } = {}) {
  const task = core.createAndLockTask(INTENT);
  const run = core.createRun({
    task_id: task.task_id,
    provider: 'cursor',
    provider_run_id: 'prov-seed',
    provider_agent_id: 'bc-seed',
  });
  core.store.updateRun(run.factory_run_id, {
    status: RUN_STATUS.RUNNING,
    started_at: new Date().toISOString(),
  });
  core._currentFactoryRunId = run.factory_run_id;
  const candidate = core.recordCandidate({
    task_id: task.task_id,
    factory_run_id: run.factory_run_id,
    branch,
    commit_sha: sha,
    pr_number: 12,
    pr_url: 'https://github.com/mac313248/jarvis-agencyos/pull/12',
  });
  return { task: core.getTask(task.task_id), run, candidate };
}

describe('Stage-1 FULL FAILURE BATTERY (item 17)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-failure-battery-'));
  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it('FB-01 WORKER CRASH: mid-run terminate preserves task + evidence; retry fresh factory_run_id', async () => {
    const launches = [];
    const provider = crashyProvider({ launches });
    const core = createBuilderCore({ workerProvider: provider });
    const task = core.createAndLockTask(INTENT);
    const { run } = await core.launchCodingWorker({
      task_id: task.task_id,
      prompt: 'battery crash',
    });
    const initial = {
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      status: core.getTask(task.task_id).status,
    };

    const observed = await core.refreshWorkerStatus(run.factory_run_id);
    assert.equal(observed.run.status, RUN_STATUS.FAILED);
    assert.equal(observed.run.failure_class, FAILURE_CLASS.PROVIDER_ERROR);
    assert.equal(core.getTask(task.task_id).task_id, task.task_id);
    assert.ok(observed.run.evidence);

    const repair = core.beginRepairAttempt(task.task_id, {
      failure_class: FAILURE_CLASS.WORKER_CRASH,
      reason: 'worker crashed mid-run',
    });
    assert.equal(repair.allowed, true);
    assert.notEqual(repair.run.factory_run_id, run.factory_run_id);

    recordBattery({
      test_id: 'FB-01',
      initial_state: initial,
      injected_failure: 'worker ERROR mid-run via status()',
      expected:
        'task durable; evidence preserved; retry allowed with fresh factory_run_id',
      actual: {
        task_status: core.getTask(task.task_id).status,
        crashed_run_status: observed.run.status,
        failure_class: observed.run.failure_class,
        evidence_preserved: Boolean(observed.run.evidence),
        fresh_factory_run_id: repair.run.factory_run_id,
        same_as_old: repair.run.factory_run_id === run.factory_run_id,
      },
      evidence: {
        events: core.store
          .listEventsForTask(task.task_id)
          .map((e) => e.event_type)
          .filter((t) =>
            [
              EVENT_TYPE.WORKER_LAUNCHED,
              EVENT_TYPE.WORKER_STATUS,
              EVENT_TYPE.RETRY_STARTED,
            ].includes(t)
          ),
        crashed_evidence: observed.run.evidence,
      },
      pass:
        observed.run.status === RUN_STATUS.FAILED &&
        Boolean(observed.run.evidence) &&
        repair.allowed &&
        repair.run.factory_run_id !== run.factory_run_id,
    });
    core.close();
  });

  it('FB-02 STALE WORKER RETURN: old run cannot regain authority', async () => {
    const launches = [];
    const provider = crashyProvider({ launches, mode: 'stable' });
    const core = createBuilderCore({ workerProvider: provider });
    const task = core.createAndLockTask(INTENT);
    const first = await core.launchCodingWorker({
      task_id: task.task_id,
      prompt: 'first',
    });
    const oldId = first.run.factory_run_id;
    core.markRunStale(oldId);

    const second = await core.launchCodingWorker({
      task_id: task.task_id,
      prompt: 'second',
    });
    assert.notEqual(second.run.factory_run_id, oldId);

    let staleCandidateBlocked = false;
    try {
      core.recordCandidate({
        task_id: task.task_id,
        factory_run_id: oldId,
        branch: 'stage1-smoke/failure-battery',
        commit_sha: SHA_A,
        pr_number: 12,
        pr_url: 'https://github.com/mac313248/jarvis-agencyos/pull/12',
      });
    } catch (err) {
      staleCandidateBlocked = err.code === 'STALE_RUN';
    }

    let staleApplyBlocked = false;
    try {
      core.applyProviderResult(oldId, {
        provider: 'cursor',
        provider_status: PROVIDER_STATUS.FINISHED,
        factory_run_id: oldId,
        provider_run_id: first.run.provider_run_id,
        provider_agent_id: first.run.provider_agent_id,
        evidence: { false_claim: 'PASS' },
      });
    } catch (err) {
      staleApplyBlocked = err.code === 'STALE_RUN';
    }

    const taskAfter = core.getTask(task.task_id);
    recordBattery({
      test_id: 'FB-02',
      initial_state: {
        old_factory_run_id: oldId,
        new_factory_run_id: second.run.factory_run_id,
      },
      injected_failure: 'stale/old run returns FINISHED after newer run is current',
      expected:
        'old run cannot register candidate / apply result / change task authority',
      actual: {
        staleCandidateBlocked,
        staleApplyBlocked,
        task_status: taskAfter.status,
        current: core._currentFactoryRunId,
      },
      evidence: {
        stale_events: core.store
          .listEventsForTask(task.task_id)
          .filter((e) => e.event_type === EVENT_TYPE.STALE_RUN_REJECTED)
          .map((e) => e.payload),
        old_run_status: core.getRun(oldId).status,
      },
      pass:
        staleCandidateBlocked &&
        staleApplyBlocked &&
        core.getRun(oldId).status === RUN_STATUS.STALE &&
        core._currentFactoryRunId === second.run.factory_run_id,
    });
    core.close();
  });

  it('FB-03 FALSE WORKER PASS: worker claim ignored when verification fails', async () => {
    const core = createBuilderCore();
    const { task, candidate } = seedActiveRun(core);
    const verified = await core.verifyCandidate(candidate.candidate_id, {
      githubClient: fakeGithub({ ciConclusion: 'failure' }),
      runTaskTests: async () => ({ ok: false, output: 'tests failed' }),
      worker_claim: 'PASS',
    });
    recordBattery({
      test_id: 'FB-03',
      initial_state: {
        candidate_id: candidate.candidate_id,
        task_status: task.status,
      },
      injected_failure: 'worker_claim=PASS with failing tests + failing CI',
      expected: 'verification FAIL/BLOCKED; not authoritative; worker claim ignored',
      actual: {
        result: verified.result,
        authoritative: core.isVerificationAuthoritative(
          verified.verification.verification_id
        ),
        candidate_status: verified.candidate.status,
        worker_claim_recorded: verified.verification.worker_claim,
      },
      evidence: {
        checks: verified.verification.checks.map((c) => ({
          name: c.name,
          ok: c.ok,
        })),
        failure_class: verified.verification.failure_class,
      },
      pass:
        verified.result === VERIFICATION_RESULT.FAIL &&
        !core.isVerificationAuthoritative(verified.verification.verification_id) &&
        verified.verification.worker_claim === 'PASS',
    });
    core.close();
  });

  it('FB-04 FINISH-LINE TAMPERING: acceptance/path mutation rejected', () => {
    const core = createBuilderCore();
    const task = core.createAndLockTask(INTENT);
    const before = {
      acceptance_ref: task.acceptance_ref,
      allowed_paths: [...task.allowed_paths],
      content_hash: task.content_hash,
      proposal_id: task.proposal_id,
    };
    let rejected = false;
    try {
      core.attemptMutateLockedTask(task.task_id, {
        acceptance_ref: 'tests/evil-golden.test.mjs',
        allowed_paths: ['/', 'secrets/'],
      });
    } catch (err) {
      rejected = /immutable field/.test(err.message);
    }
    const after = core.getTask(task.task_id);
    recordBattery({
      test_id: 'FB-04',
      initial_state: before,
      injected_failure: 'mutate acceptance_ref + allowed_paths after lock',
      expected: 'mutation rejected; lock hash unchanged',
      actual: {
        rejected,
        acceptance_ref: after.acceptance_ref,
        allowed_paths: after.allowed_paths,
        content_hash: after.content_hash,
      },
      evidence: {
        proposal_id: after.proposal_id,
        hash_unchanged: after.content_hash === before.content_hash,
      },
      pass:
        rejected &&
        after.acceptance_ref === before.acceptance_ref &&
        after.content_hash === before.content_hash &&
        JSON.stringify(after.allowed_paths) === JSON.stringify(before.allowed_paths),
    });
    core.close();
  });

  it('FB-05 CI FAILURE: failing CI cannot PASS; old CI cannot authorize new SHA', async () => {
    const core = createBuilderCore();
    const { task, run } = seedActiveRun(core, { sha: SHA_A });
    const candA = core.store.listCandidatesForTask(task.task_id)[0];
    const failA = await core.verifyCandidate(candA.candidate_id, {
      githubClient: fakeGithub({ sha: SHA_A, ciConclusion: 'failure' }),
      runTaskTests: async () => ({ ok: true, output: 'local ok' }),
    });
    assert.equal(failA.result, VERIFICATION_RESULT.FAIL);

    const candB = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'stage1-smoke/failure-battery',
      commit_sha: SHA_B,
      pr_number: 12,
      pr_url: 'https://github.com/mac313248/jarvis-agencyos/pull/12',
    });
    const passBAttempt = await core.verifyCandidate(candB.candidate_id, {
      githubClient: fakeGithub({ sha: SHA_B, ciConclusion: 'success' }),
      runTaskTests: async () => ({ ok: true, output: 'ok' }),
    });

    recordBattery({
      test_id: 'FB-05',
      initial_state: {
        candA: candA.candidate_id,
        shaA: SHA_A,
      },
      injected_failure: 'CI failure on SHA A; then new SHA B candidate',
      expected:
        'A cannot PASS; A verification not authoritative for B; B needs its own evidence',
      actual: {
        a_result: failA.result,
        a_authoritative: core.isVerificationAuthoritative(
          failA.verification.verification_id
        ),
        a_status_after_b: core.store.getCandidate(candA.candidate_id).status,
        b_result: passBAttempt.result,
        b_sha: candB.commit_sha,
      },
      evidence: {
        a_ci: failA.verification.checks.find((c) => c.name === 'github_ci'),
        a_superseded:
          core.store.getCandidate(candA.candidate_id).status ===
          CANDIDATE_STATUS.SUPERSEDED,
      },
      pass:
        failA.result === VERIFICATION_RESULT.FAIL &&
        !core.isVerificationAuthoritative(failA.verification.verification_id) &&
        core.store.getCandidate(candA.candidate_id).status ===
          CANDIDATE_STATUS.SUPERSEDED &&
        candB.commit_sha === SHA_B &&
        passBAttempt.verification.commit_sha === SHA_B,
    });
    core.close();
  });

  it('FB-06 APPROVAL INVALIDATION: approval for A invalid for B', async () => {
    const core = createBuilderCore();
    const { task, run, candidate } = seedActiveRun(core, { sha: SHA_A });
    await core.verifyCandidate(candidate.candidate_id, {
      githubClient: fakeGithub({ sha: SHA_A }),
      runTaskTests: async () => ({ ok: true, output: 'ok' }),
    });
    const approvalA = core.recordApproval({
      task_id: task.task_id,
      approved_by: 'owner',
      candidate_id: candidate.candidate_id,
      commit_sha: SHA_A,
      status: APPROVAL_STATUS.APPROVED,
    });
    const candB = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'stage1-smoke/failure-battery',
      commit_sha: SHA_B,
      pr_number: 12,
      pr_url: 'https://github.com/mac313248/jarvis-agencyos/pull/12',
    });
    const approvalAfter = core.store.getApproval(approvalA.approval_id);
    recordBattery({
      test_id: 'FB-06',
      initial_state: {
        approval_id: approvalA.approval_id,
        candidate_a: candidate.candidate_id,
        sha: SHA_A,
      },
      injected_failure: 'new candidate B with different SHA',
      expected: 'approval A invalidated; cannot authorize B',
      actual: {
        approval_status: approvalAfter.status,
        candidate_b: candB.candidate_id,
        binds_b:
          approvalAfter.candidate_id === candB.candidate_id &&
          approvalAfter.commit_sha === SHA_B,
      },
      evidence: {
        invalidation_events: core.store
          .listEventsForTask(task.task_id)
          .filter((e) => e.event_type === EVENT_TYPE.APPROVAL_INVALIDATED)
          .map((e) => e.payload),
      },
      pass:
        approvalAfter.status === APPROVAL_STATUS.INVALIDATED &&
        approvalAfter.candidate_id === candidate.candidate_id &&
        approvalAfter.commit_sha === SHA_A &&
        candB.commit_sha === SHA_B,
    });
    core.close();
  });

  it('FB-07 REVIEW INVALIDATION: review PASS for A cannot authorize B', async () => {
    const core = createBuilderCore();
    const { task, run, candidate } = seedActiveRun(core, { sha: SHA_A });
    await core.verifyCandidate(candidate.candidate_id, {
      githubClient: fakeGithub({ sha: SHA_A }),
      runTaskTests: async () => ({ ok: true, output: 'ok' }),
    });
    const { review } = await core.reviewCandidate(candidate.candidate_id, {
      invoker: {
        mode: 'read-only',
        async review() {
          return {
            ok: true,
            review_status: REVIEW_STATUS.PASS,
            findings: [],
            raw: JSON.stringify({ review_status: 'PASS', findings: [] }),
          };
        },
      },
      getDiff: async () => 'diff a',
    });
    assert.equal(core.isReviewAuthoritative(review.review_id), true);

    const candB = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'stage1-smoke/failure-battery',
      commit_sha: SHA_B,
      pr_number: 12,
      pr_url: 'https://github.com/mac313248/jarvis-agencyos/pull/12',
    });

    recordBattery({
      test_id: 'FB-07',
      initial_state: {
        review_id: review.review_id,
        sha: SHA_A,
      },
      injected_failure: 'candidate SHA changes A -> B after Codex PASS',
      expected: 'old review invalidated / not authoritative for B',
      actual: {
        review_invalidated: Boolean(core.store.getReview(review.review_id).invalidated_at),
        review_authoritative: core.isReviewAuthoritative(review.review_id),
        candidate_b: candB.candidate_id,
        review_sha: review.commit_sha,
      },
      evidence: {
        review_status: review.review_status,
        a_superseded:
          core.store.getCandidate(candidate.candidate_id).status ===
          CANDIDATE_STATUS.SUPERSEDED,
      },
      pass:
        Boolean(core.store.getReview(review.review_id).invalidated_at) &&
        !core.isReviewAuthoritative(review.review_id) &&
        review.commit_sha === SHA_A &&
        candB.commit_sha === SHA_B,
    });
    core.close();
  });

  it('FB-08 RESEARCH/TOOL PROVIDER FAILURE: fallback only if already permitted else BLOCKED', async () => {
    const core = createBuilderCore();
    const task = core.createAndLockTask({
      ...INTENT,
      tool_manifest: {
        providers: ['github', 'web_search'],
        tools: ['repo_read', 'research'],
        mode: 'build',
      },
    });
    const fallback = await core.invokeTool({
      task_id: task.task_id,
      provider: 'github',
      tool: 'repo_read',
      // Exactly one other permitted provider remains available.
      availability: { github: false, web_search: true },
      invoke: async ({ provider, fallback: fb }) => ({
        provider,
        fallback: fb,
        text: 'ok',
      }),
    });

    const core2 = createBuilderCore();
    const task2 = core2.createAndLockTask({
      ...INTENT,
      tool_manifest: {
        providers: ['github'],
        tools: ['repo_read'],
        mode: 'build',
      },
    });
    let unavailableBlocked = false;
    try {
      await core2.invokeTool({
        task_id: task2.task_id,
        provider: 'github',
        tool: 'repo_read',
        availability: { github: false },
        invoke: async () => ({ ok: true }),
      });
    } catch (err) {
      unavailableBlocked = err instanceof ToolPolicyError && err.code === 'PROVIDER_UNAVAILABLE';
    }

    let widenRejected = false;
    try {
      core.attemptMutateLockedTask(task.task_id, {
        tool_manifest: {
          providers: ['github', 'web_search', 'shell'],
          tools: ['repo_read', 'research', 'shell_exec'],
          mode: 'build',
        },
      });
    } catch (err) {
      widenRejected = /immutable field 'tool_manifest'/.test(err.message);
    }

    recordBattery({
      test_id: 'FB-08',
      initial_state: {
        providers: INTENT.tool_manifest.providers,
      },
      injected_failure: 'github unavailable; attempt auto-widen shell',
      expected: 'permitted fallback only; else BLOCKED; no permission widening',
      actual: {
        fallback_provider: fallback.evidence.provider,
        fallback_flag: fallback.evidence.fallback,
        unavailableBlocked,
        widenRejected,
        task2_status: core2.getTask(task2.task_id).status,
      },
      evidence: {
        fallback_evidence_id: fallback.evidence.evidence_id,
        denied_events: core2.store
          .listEventsForTask(task2.task_id)
          .filter((e) => e.event_type === EVENT_TYPE.TOOL_DENIED)
          .map((e) => e.payload?.code),
      },
      pass:
        fallback.evidence.provider === 'web_search' &&
        fallback.evidence.fallback === true &&
        unavailableBlocked &&
        widenRejected &&
        core2.getTask(task2.task_id).status === TASK_STATUS.BLOCKED,
    });
    core.close();
    core2.close();
  });

  it('FB-09 AUTHORITY/STATE CORRUPTION: ambiguous bindings fail closed', async () => {
    const db = join(dir, 'corrupt.sqlite');
    const core1 = createBuilderCore({ dbPath: db });
    const task = core1.createAndLockTask(INTENT);
    const runA = core1.createRun({
      task_id: task.task_id,
      provider: 'cursor',
      provider_run_id: 'a',
    });
    core1.store.updateRun(runA.factory_run_id, {
      status: RUN_STATUS.RUNNING,
      started_at: new Date().toISOString(),
    });
    core1.store.insertRun({
      factory_run_id: 'run_forced_ambiguous_active',
      task_id: task.task_id,
      provider: 'cursor',
      provider_run_id: 'b',
      attempt: 2,
      status: RUN_STATUS.RUNNING,
      started_at: new Date().toISOString(),
    });
    core1.close();

    const core2 = createBuilderCore({ dbPath: db, autoRecover: true });
    const recovery = await core2.recover();
    recordBattery({
      test_id: 'FB-09',
      initial_state: { task_id: task.task_id, active_runs: 2 },
      injected_failure: 'two durable RUNNING runs after restart',
      expected: 'recovery BLOCKED; no guessed current_factory_run_id',
      actual: {
        recovery_status: recovery.status,
        reason: recovery.reason,
        current_factory_run_id: recovery.current_factory_run_id,
        pointer: core2._currentFactoryRunId,
      },
      evidence: {
        events: core2.store.db
          .prepare(`SELECT event_type FROM events`)
          .all()
          .map((r) => r.event_type),
      },
      pass:
        recovery.status === 'BLOCKED' &&
        recovery.reason === 'MULTIPLE_ACTIVE_RUNS' &&
        recovery.current_factory_run_id == null &&
        core2._currentFactoryRunId == null,
    });
    core2.close();
  });

  it('FB-10 RESTART DURING ACTIVE WORK: reconstruct; no duplicate launch', async () => {
    const launches = [];
    const db = join(dir, 'restart-active.sqlite');
    const provider = crashyProvider({ launches, mode: 'stable' });
    const core1 = createBuilderCore({ dbPath: db, workerProvider: provider });
    const task = core1.createAndLockTask(INTENT);
    const launched = await core1.launchCodingWorker({
      task_id: task.task_id,
      prompt: 'active work',
    });
    const runId = launched.run.factory_run_id;
    core1.close();

    const core2 = createBuilderCore({
      dbPath: db,
      workerProvider: provider,
      autoRecover: true,
    });
    const recovery = await core2.recover({
      reconcileProviderStatus: async ({ factory_run_id }) => ({
        ok: true,
        read_only: true,
        factory_run_id,
        provider_status: PROVIDER_STATUS.RUNNING,
      }),
    });
    let duplicateBlocked = false;
    try {
      await core2.launchCodingWorker({ task_id: task.task_id, prompt: 'dup' });
    } catch (err) {
      duplicateBlocked = err.code === 'ACTIVE_WORKER_EXISTS';
    }

    recordBattery({
      test_id: 'FB-10',
      initial_state: { factory_run_id: runId, launches_before_restart: 1 },
      injected_failure: 'process restart while run RUNNING',
      expected: 'reconstruct current run; no second launch',
      actual: {
        recovery_status: recovery.status,
        current_factory_run_id: recovery.current_factory_run_id,
        launches_after: launches.length,
        duplicateBlocked,
      },
      evidence: {
        provider_status: recovery.provider_status,
        duplicate_launch_prevented: recovery.duplicate_launch_prevented,
      },
      pass:
        recovery.status === 'OK' &&
        recovery.current_factory_run_id === runId &&
        launches.length === 1 &&
        duplicateBlocked,
    });
    core2.close();
  });

  it('FB-11 RETRY EXHAUSTION: stops at caps; never infinite retry', () => {
    const core = createBuilderCore();
    const task = core.createAndLockTask({ ...INTENT, max_attempts: 2 });
    const run1 = core.createRun({
      task_id: task.task_id,
      provider: 'cursor',
      provider_run_id: 'r1',
    });
    core.store.updateRun(run1.factory_run_id, {
      status: RUN_STATUS.FAILED,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      failure_class: FAILURE_CLASS.TEST_FAIL,
    });
    core.updateTaskStatus(task.task_id, TASK_STATUS.RUNNING);

    const r1 = core.beginRepairAttempt(task.task_id, {
      failure_class: FAILURE_CLASS.TEST_FAIL,
      reason: 'retry 1',
    });
    assert.equal(r1.allowed, true);
    core.store.updateRun(r1.run.factory_run_id, {
      status: RUN_STATUS.FAILED,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      failure_class: FAILURE_CLASS.TEST_FAIL,
    });

    const exhausted = core.beginRepairAttempt(task.task_id, {
      failure_class: FAILURE_CLASS.TEST_FAIL,
      reason: 'retry 2 should exhaust',
    });

    const policyDenied = core.beginRepairAttempt(task.task_id, {
      failure_class: FAILURE_CLASS.POLICY_VIOLATION,
      reason: 'security failure must not retry-weaken',
    });

    recordBattery({
      test_id: 'FB-11',
      initial_state: { max_attempts: 2, first_run: run1.factory_run_id },
      injected_failure: 'repeated TEST_FAIL beyond max_attempts + POLICY_VIOLATION',
      expected: 'NEEDS_OWNER/BLOCKED; no infinite retry; policy failures non-retryable',
      actual: {
        first_retry_allowed: r1.allowed,
        exhausted_allowed: exhausted.allowed,
        exhausted_stop: exhausted.stop_status,
        policy_allowed: policyDenied.allowed,
        policy_stop: policyDenied.stop_status,
        final_status: core.getTask(task.task_id).status,
      },
      evidence: {
        events: core.store
          .listEventsForTask(task.task_id)
          .filter((e) =>
            [
              EVENT_TYPE.RETRY_STARTED,
              EVENT_TYPE.RETRY_EXHAUSTED,
              EVENT_TYPE.RETRY_DENIED,
            ].includes(e.event_type)
          )
          .map((e) => e.event_type),
      },
      pass:
        r1.allowed === true &&
        exhausted.allowed === false &&
        exhausted.stop_status === TASK_STATUS.NEEDS_OWNER &&
        policyDenied.allowed === false &&
        policyDenied.stop_status === TASK_STATUS.BLOCKED,
    });
    core.close();
  });

  it('FB-12 SECURITY POLICY FAILURE: credentials/tools/paths fail closed; no weaken-retry', async () => {
    let credBlocked = false;
    try {
      assertNoBusinessCredentials({ GHL_API_KEY: 'secret' });
    } catch (err) {
      credBlocked = err.code === 'BUSINESS_CREDENTIAL_FORBIDDEN';
    }

    const core = createBuilderCore();
    const task = core.createAndLockTask(INTENT);

    // Credential policy is enforced at the provider boundary (CursorProvider).
    // Battery uses the shared guard directly — never launch with secrets.
    assert.throws(
      () => assertNoBusinessCredentials({ STRIPE_SECRET: 'sk_test' }),
      (err) => err.code === 'BUSINESS_CREDENTIAL_FORBIDDEN'
    );

    let toolBlocked = false;
    try {
      await core.invokeTool({
        task_id: task.task_id,
        provider: 'github',
        tool: 'shell_exec',
        invoke: async () => ({ ok: true }),
      });
    } catch (err) {
      toolBlocked = err instanceof ToolPolicyError && err.code === 'UNAUTHORIZED_TOOL';
    }

    let researchAuthBlocked = false;
    try {
      await core.invokeResearch({
        task_id: task.task_id,
        provider: 'web_search',
        tool: 'research',
        invoke: async () => ({
          allowed_paths: ['/'],
          credentials: { token: 'x' },
          mark_done: true,
        }),
      });
    } catch (err) {
      researchAuthBlocked = err.code === 'RESEARCH_AUTHORITY_VIOLATION';
    }

    const noWeaken = core.beginRepairAttempt(task.task_id, {
      failure_class: FAILURE_CLASS.POLICY_VIOLATION,
      reason: 'security policy failure',
    });

    recordBattery({
      test_id: 'FB-12',
      initial_state: {
        task_id: task.task_id,
        tool_manifest: task.tool_manifest,
      },
      injected_failure:
        'business credentials + unauthorized tool + research authority widen',
      expected: 'fail closed; POLICY_VIOLATION not retry-weakened',
      actual: {
        credBlocked,
        toolBlocked,
        researchAuthBlocked,
        retry_allowed: noWeaken.allowed,
        retry_stop: noWeaken.stop_status,
      },
      evidence: {
        task_status: core.getTask(task.task_id).status,
        denied: core.store
          .listEventsForTask(task.task_id)
          .filter((e) => e.event_type === EVENT_TYPE.TOOL_DENIED)
          .map((e) => e.payload?.code),
      },
      pass:
        credBlocked &&
        toolBlocked &&
        researchAuthBlocked &&
        noWeaken.allowed === false &&
        noWeaken.stop_status === TASK_STATUS.BLOCKED,
    });
    core.close();
  });
});
