// Stage-1 items 11–14: Codex review gate, approval/stale verification, retry.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  createBuilderCore,
  BuilderCoreError,
  CANDIDATE_STATUS,
  TASK_STATUS,
  RUN_STATUS,
  APPROVAL_STATUS,
  REVIEW_STATUS,
  VERIFICATION_RESULT,
  FAILURE_CLASS,
  EVENT_TYPE,
  createCodexReviewInvoker,
  parseCodexReviewOutput,
  CodexReviewError,
} from '../src/builder/index.js';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function baseIntent(overrides = {}) {
  return {
    intent: 'Stage-1 Codex review + retry control gates',
    acceptance_ref: 'tests/builder-stage1-review-retry.test.mjs',
    allowed_paths: ['src/builder/', 'tests/builder-stage1-review-retry.test.mjs'],
    tool_manifest: { providers: ['github'], tools: ['repo_read'], mode: 'build' },
    review_required: true,
    max_attempts: 2,
    ...overrides,
  };
}

function seedCandidate(core, { review_required = true, sha = SHA_A } = {}) {
  const task = core.createAndLockTask(baseIntent({ review_required }));
  const run = core.createRun({
    task_id: task.task_id,
    provider: 'cursor',
    provider_run_id: 'run-review-1',
    provider_agent_id: 'bc-review-1',
  });
  core.store.updateRun(run.factory_run_id, {
    status: RUN_STATUS.RUNNING,
    started_at: new Date().toISOString(),
  });
  core._currentFactoryRunId = run.factory_run_id;
  const candidate = core.recordCandidate({
    task_id: task.task_id,
    factory_run_id: run.factory_run_id,
    branch: 'stage1-smoke/review',
    commit_sha: sha,
    pr_number: 7,
    pr_url: 'https://github.com/mac313248/jarvis-agencyos/pull/7',
  });
  return { task: core.getTask(task.task_id), run, candidate };
}

function reviewGithub({
  sha = SHA_A,
  branch = 'stage1-smoke/review',
  prNumber = 7,
  prUrl = 'https://github.com/mac313248/jarvis-agencyos/pull/7',
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
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          html_url: prUrl,
        },
      ];
    },
    async getCombinedStatusForCommit() {
      return { state: 'success', statuses: [], total_count: 1 };
    },
    summarizeCi({ checkRuns = [], combinedStatus = null } = {}) {
      return {
        ci_status: 'completed',
        ci_conclusion: 'success',
        checks: checkRuns.map((r) => ({
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
        })),
        combined_state: combinedStatus?.state || 'success',
        captured_at: new Date().toISOString(),
      };
    },
  };
}

async function passVerifier(core, candidateId, sha = SHA_A) {
  const candidate = core.store.getCandidate(candidateId);
  return core.verifyCandidate(candidateId, {
    githubClient: reviewGithub({
      sha,
      branch: candidate.branch,
      prNumber: candidate.pr_number,
      prUrl: candidate.pr_url,
    }),
    runTaskTests: async () => ({ ok: true, output: 'ok' }),
    runBuildChecks: async () => ({ ok: true, output: 'ok' }),
  });
}

function fakeInvoker(status = REVIEW_STATUS.PASS, findings = []) {
  return {
    mode: 'read-only',
    async review() {
      return {
        ok: true,
        raw: JSON.stringify({ review_status: status, findings }),
      };
    },
  };
}

describe('Stage-1 Codex review (item 11)', () => {
  it('defaults review_required=true and requires verifier before Codex', async () => {
    const core = createBuilderCore();
    const { task, candidate } = seedCandidate(core);
    assert.equal(task.review_required, true);
    await assert.rejects(
      () =>
        core.reviewCandidate(candidate.candidate_id, {
          invoker: fakeInvoker(),
        }),
      (err) => err.code === 'VERIFIER_REQUIRED_FIRST'
    );
    core.close();
  });

  it('A–C: stores Codex review bound to exact candidate/SHA', async () => {
    const core = createBuilderCore();
    const { task, candidate } = seedCandidate(core);
    const verified = await passVerifier(core, candidate.candidate_id);
    assert.equal(verified.result, VERIFICATION_RESULT.PASS);
    const { review, gate } = await core.reviewCandidate(candidate.candidate_id, {
      invoker: fakeInvoker(REVIEW_STATUS.PASS, ['looks good']),
      getDiff: async () => 'diff --git a/x b/x\n+ok\n',
    });
    assert.ok(review.review_id.startsWith('rev_'));
    assert.equal(review.candidate_id, candidate.candidate_id);
    assert.equal(review.commit_sha, SHA_A);
    assert.equal(review.review_status, REVIEW_STATUS.PASS);
    assert.deepEqual(review.findings, ['looks good']);
    assert.ok(review.reviewed_at);
    assert.equal(gate.ok, true);
    assert.equal(core.isReviewAuthoritative(review.review_id), true);
    assert.equal(
      core.store.getCandidate(candidate.candidate_id).review_ref,
      review.review_id
    );
    assert.equal(task.review_required, true);
    core.close();
  });

  it('D: SHA change invalidates old review', async () => {
    const core = createBuilderCore();
    const { task, run, candidate } = seedCandidate(core);
    await passVerifier(core, candidate.candidate_id);
    const { review } = await core.reviewCandidate(candidate.candidate_id, {
      invoker: fakeInvoker(),
    });
    const next = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'stage1-smoke/review',
      commit_sha: SHA_B,
    });
    assert.equal(next.commit_sha, SHA_B);
    assert.ok(core.store.getReview(review.review_id).invalidated_at);
    assert.equal(core.isReviewAuthoritative(review.review_id), false);
    core.close();
  });

  it('re-verify invalidates prior PASS review authority', async () => {
    const core = createBuilderCore();
    const { candidate } = seedCandidate(core);
    await passVerifier(core, candidate.candidate_id);
    const { review } = await core.reviewCandidate(candidate.candidate_id, {
      invoker: fakeInvoker(REVIEW_STATUS.PASS, ['ok']),
    });
    assert.equal(core.isReviewAuthoritative(review.review_id), true);

    const second = await passVerifier(core, candidate.candidate_id);
    assert.equal(second.result, VERIFICATION_RESULT.PASS);
    assert.ok(core.store.getReview(review.review_id).invalidated_at);
    assert.equal(core.store.getCandidate(candidate.candidate_id).review_ref, null);
    assert.equal(core.isReviewAuthoritative(review.review_id), false);
    assert.notEqual(
      review.evidence?.verification_id,
      second.verification.verification_id
    );
    core.close();
  });

  it('stale caller-supplied verification cannot authorize Codex review', async () => {
    const core = createBuilderCore();
    const { candidate } = seedCandidate(core);
    const first = await passVerifier(core, candidate.candidate_id);
    assert.equal(first.result, VERIFICATION_RESULT.PASS);
    assert.equal(
      core.isVerificationAuthoritative(first.verification.verification_id),
      true
    );

    // Landing/CI change clears verification_ref and invalidates prior PASS.
    const failingGh = {
      ...reviewGithub(),
      summarizeCi() {
        return {
          ci_status: 'completed',
          ci_conclusion: 'failure',
          checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
          combined_state: 'failure',
          captured_at: new Date().toISOString(),
        };
      },
      async getCheckRunsForCommit() {
        return [
          {
            id: 1,
            name: 'ci',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/mac313248/jarvis-agencyos/pull/7',
          },
        ];
      },
      async getCombinedStatusForCommit() {
        return { state: 'failure', statuses: [], total_count: 1 };
      },
    };
    await core.refreshCandidateLanding(candidate.candidate_id, failingGh);
    assert.equal(core.store.getCandidate(candidate.candidate_id).verification_ref, null);
    assert.equal(
      core.isVerificationAuthoritative(first.verification.verification_id),
      false
    );

    await assert.rejects(
      () =>
        core.reviewCandidate(candidate.candidate_id, {
          invoker: fakeInvoker(REVIEW_STATUS.PASS, ['stale pass']),
          verification: first.verification,
        }),
      (err) => err.code === 'VERIFIER_REQUIRED_FIRST'
    );
    core.close();
  });

  it('E: REQUEST_CHANGES prevents acceptance gate', async () => {
    const core = createBuilderCore();
    const { candidate } = seedCandidate(core);
    const verified = await passVerifier(core, candidate.candidate_id);
    const { review, gate } = await core.reviewCandidate(candidate.candidate_id, {
      invoker: fakeInvoker(REVIEW_STATUS.REQUEST_CHANGES, ['fix the bug']),
    });
    assert.equal(review.review_status, REVIEW_STATUS.REQUEST_CHANGES);
    assert.equal(gate.ok, false);
    assert.equal(gate.status, 'FAIL');
    assert.equal(
      core.store.getCandidate(candidate.candidate_id).status,
      CANDIDATE_STATUS.REJECTED
    );
    assert.equal(
      core.evaluateReviewGate({
        task: core.getTask(candidate.task_id),
        verification: verified.verification,
        review,
      }).ok,
      false
    );
    core.close();
  });

  it('F: Codex failure when review_required=true => BLOCKED', async () => {
    const core = createBuilderCore();
    const { candidate } = seedCandidate(core);
    await passVerifier(core, candidate.candidate_id);
    const { review, gate } = await core.reviewCandidate(candidate.candidate_id, {
      invoker: {
        mode: 'read-only',
        async review() {
          return {
            ok: false,
            error: { code: 'TIMEOUT', message: 'codex timed out' },
          };
        },
      },
    });
    assert.equal(review.review_status, REVIEW_STATUS.BLOCKED);
    assert.equal(gate.ok, false);
    assert.equal(gate.status, 'BLOCKED');
    assert.equal(core.getTask(candidate.task_id).status, TASK_STATUS.BLOCKED);
    core.close();
  });

  it('G: review_required=false bypasses Codex only, not deterministic verification', async () => {
    const core = createBuilderCore();
    const { candidate } = seedCandidate(core, { review_required: false });
    await assert.rejects(
      () =>
        core.reviewCandidate(candidate.candidate_id, {
          invoker: fakeInvoker(),
        }),
      (err) => err.code === 'VERIFIER_REQUIRED_FIRST'
    );
    const verified = await passVerifier(core, candidate.candidate_id);
    const { review, gate } = await core.reviewCandidate(candidate.candidate_id, {
      invoker: {
        mode: 'read-only',
        async review() {
          throw new Error('Codex must not be called when bypassed');
        },
      },
    });
    assert.equal(review.evidence.bypassed, true);
    assert.equal(gate.ok, true);
    assert.equal(gate.review_bypassed, true);
    assert.equal(verified.result, VERIFICATION_RESULT.PASS);
    core.close();
  });

  it('H: reviewer cannot modify candidate/task/acceptance', () => {
    const core = createBuilderCore();
    const { task } = seedCandidate(core);
    assert.throws(
      () =>
        core.assertReviewerCannotMutate(task.task_id, {
          acceptance_ref: 'evil',
        }),
      (err) =>
        err instanceof CodexReviewError &&
        err.code === 'REVIEWER_MUTATION_FORBIDDEN'
    );
    assert.throws(
      () =>
        core.assertReviewerCannotMutate(task.task_id, {
          commit_sha: SHA_B,
        }),
      (err) => err.code === 'REVIEWER_MUTATION_FORBIDDEN'
    );
    core.close();
  });

  it('parses Codex JSONL/agent_message protocol', () => {
    const parsed = parseCodexReviewOutput(
      [
        '{"type":"item","item":{"type":"agent_message","text":"{\\"review_status\\":\\"PASS\\",\\"findings\\":[]}"}}',
      ].join('\n')
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.review_status, REVIEW_STATUS.PASS);
  });
});

describe('Stage-1 approval binding (item 12) + stale-run fencing (item 13)', () => {
  it('approval binds proposal_id + content_hash + candidate/commit and invalidates on SHA change', async () => {
    const core = createBuilderCore();
    const { task, run, candidate } = seedCandidate(core);
    await passVerifier(core, candidate.candidate_id);
    const approval = core.recordApproval({
      task_id: task.task_id,
      approved_by: 'owner',
      candidate_id: candidate.candidate_id,
      commit_sha: SHA_A,
    });
    assert.equal(approval.proposal_id, task.proposal_id);
    assert.equal(approval.content_hash, task.content_hash);
    assert.equal(approval.candidate_id, candidate.candidate_id);
    assert.equal(approval.commit_sha, SHA_A);

    core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'stage1-smoke/review',
      commit_sha: SHA_B,
    });
    assert.equal(
      core.store.getApproval(approval.approval_id).status,
      APPROVAL_STATUS.INVALIDATED
    );
    core.close();
  });

  it('stale/cancelled run cannot produce authoritative candidate/review', async () => {
    const core = createBuilderCore();
    const { task, run, candidate } = seedCandidate(core);
    await passVerifier(core, candidate.candidate_id);
    core.store.updateRun(run.factory_run_id, {
      status: RUN_STATUS.CANCELLED,
      ended_at: new Date().toISOString(),
    });
    core._currentFactoryRunId = null;
    assert.throws(
      () =>
        core.recordCandidate({
          task_id: task.task_id,
          factory_run_id: run.factory_run_id,
          branch: 'x',
          commit_sha: SHA_B,
        }),
      (err) => err instanceof BuilderCoreError && err.code === 'STALE_RUN'
    );
    await assert.rejects(
      () =>
        core.reviewCandidate(candidate.candidate_id, {
          invoker: fakeInvoker(),
        }),
      (err) => err.code === 'STALE_RUN'
    );
    core.close();
  });
});

describe('Stage-1 bounded retry/repair (item 14)', () => {
  it('mints fresh factory_run_id, enforces caps, denies hard policy failures', () => {
    const core = createBuilderCore();
    const task = core.createAndLockTask(
      baseIntent({ max_attempts: 2, max_runtime_ms: 60_000 })
    );
    const policy = core.getRetryPolicy(task.task_id);
    assert.equal(policy.max_attempts, 2);
    assert.equal(policy.cost_budget.status, 'UNKNOWN');
    assert.equal(policy.cost_budget.supported, false);

    const run1 = core.createRun({
      task_id: task.task_id,
      provider: 'cursor',
      provider_run_id: 'p1',
    });
    core.store.updateRun(run1.factory_run_id, {
      status: RUN_STATUS.RUNNING,
      started_at: new Date().toISOString(),
    });
    core._currentFactoryRunId = run1.factory_run_id;

    const denied = core.beginRepairAttempt(task.task_id, {
      failure_class: FAILURE_CLASS.ACCEPTANCE_TAMPER,
      reason: 'tamper',
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.stop_status, TASK_STATUS.BLOCKED);

    // Reset to running with retryable failure path.
    core.updateTaskStatus(task.task_id, TASK_STATUS.RUNNING);
    const r1 = core.beginRepairAttempt(task.task_id, {
      failure_class: FAILURE_CLASS.TEST_FAIL,
      reason: 'tests failed',
    });
    assert.equal(r1.allowed, true);
    assert.ok(r1.run.factory_run_id !== run1.factory_run_id);
    assert.equal(r1.run.attempt, 2);
    core.store.updateRun(r1.run.factory_run_id, {
      status: RUN_STATUS.RUNNING,
      started_at: new Date().toISOString(),
    });

    const exhausted = core.beginRepairAttempt(task.task_id, {
      failure_class: FAILURE_CLASS.TEST_FAIL,
      reason: 'still failing',
    });
    assert.equal(exhausted.allowed, false);
    assert.equal(exhausted.stop_status, TASK_STATUS.NEEDS_OWNER);
    assert.equal(exhausted.failure_class, FAILURE_CLASS.ATTEMPT_CAP);
    assert.ok(
      core.store
        .listEventsForTask(task.task_id)
        .some((e) => e.event_type === EVENT_TYPE.RETRY_EXHAUSTED)
    );
    core.close();
  });
});

describe('Stage-1 live Codex review smoke', () => {
  it('A–C live: Codex read-only review of exact candidate SHA', async () => {
    let codexOk = false;
    try {
      execFileSync('codex', ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      codexOk = true;
    } catch {
      codexOk = false;
    }
    if (!codexOk) {
      console.log('LIVE_CODEX_REVIEW_BLOCKED reason=codex_cli_unavailable');
      return;
    }

    const repoRoot = new URL('..', import.meta.url).pathname;
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const diff = execFileSync(
      'git',
      ['show', '--stat', '--oneline', '-1', sha],
      { cwd: repoRoot, encoding: 'utf8' }
    );

    const core = createBuilderCore();
    const { candidate } = seedCandidate(core, { sha });
    // Live GitHub CI on HEAD may be unavailable here; use bound landing fixture
    // for deterministic PASS, then Codex reviews the exact live SHA.
    await passVerifier(core, candidate.candidate_id, sha);

    const invoker = createCodexReviewInvoker({
      repoRoot,
      timeoutMs: 8 * 60 * 1000,
    });
    const { review, gate } = await core.reviewCandidate(candidate.candidate_id, {
      invoker,
      getDiff: async () => diff,
    });

    assert.equal(review.candidate_id, candidate.candidate_id);
    assert.equal(review.commit_sha, sha);
    assert.ok(Object.values(REVIEW_STATUS).includes(review.review_status));
    assert.ok(Array.isArray(review.findings));
    assert.ok(review.reviewed_at);
    // Live outcome may be PASS/REQUEST_CHANGES/BLOCKED; must be stored + SHA-bound.
    assert.equal(typeof gate.ok, 'boolean');
    console.log(
      'LIVE_CODEX_REVIEW review_id=%s candidate_id=%s commit_sha=%s review_status=%s gate=%s',
      review.review_id,
      candidate.candidate_id,
      sha,
      review.review_status,
      gate.status
    );
    core.close();
  });
});
