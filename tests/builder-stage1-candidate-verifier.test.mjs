// Stage-1 Build Order items 9–10: exact GitHub candidate registry + verifier.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBuilderCore,
  BuilderCoreError,
  CANDIDATE_STATUS,
  TASK_STATUS,
  RUN_STATUS,
  APPROVAL_STATUS,
  VERIFICATION_RESULT,
  EVENT_TYPE,
  createGhLandingClient,
  VerifierError,
} from '../src/builder/index.js';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const INTENT = {
  intent: 'Exact candidate registry + SHA-bound verifier',
  acceptance_ref: 'tests/builder-stage1-candidate-verifier.test.mjs',
  allowed_paths: ['src/builder/', 'tests/builder-stage1-candidate-verifier.test.mjs'],
  tool_manifest: { providers: ['github'], tools: ['repo_read'], mode: 'build' },
  review_required: true,
};

function makeCoreWithActiveRun() {
  const core = createBuilderCore();
  const task = core.createAndLockTask(INTENT);
  const run = core.createRun({
    task_id: task.task_id,
    provider: 'cursor',
    provider_run_id: 'run-fake-provider-1',
    provider_agent_id: 'bc-fake-1',
  });
  core.store.updateRun(run.factory_run_id, {
    status: RUN_STATUS.RUNNING,
    started_at: new Date().toISOString(),
  });
  core._currentFactoryRunId = run.factory_run_id;
  return { core, task, run };
}

function fakeGithub({
  sha = SHA_A,
  prNumber = 42,
  prUrl = 'https://github.com/mac313248/jarvis-agencyos/pull/42',
  branch = 'stage1-smoke/candidate-demo',
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
          name: 'Phase 1 — Secure Core Spine / phase1',
          status: ciStatus === 'pending' ? 'in_progress' : 'completed',
          conclusion: ciStatus === 'pending' ? null : ciConclusion,
          html_url: prUrl,
        },
      ];
    },
    async getCombinedStatusForCommit(requested) {
      assert.equal(requested, sha);
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

describe('Stage-1 candidate registry + verifier (items 9–10)', () => {
  it('A–E: binds branch/SHA/PR/CI and verification to exact SHA', async () => {
    const { core, task, run } = makeCoreWithActiveRun();
    const candidate = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'stage1-smoke/candidate-demo',
      commit_sha: SHA_A,
      pr_number: 42,
      pr_url: 'https://github.com/mac313248/jarvis-agencyos/pull/42',
      ci_status: 'completed',
      ci_conclusion: 'success',
      evidence_at: '2026-08-11T01:00:00.000Z',
      worker_claim: 'PASS — ignore me',
    });

    assert.equal(candidate.task_id, task.task_id);
    assert.equal(candidate.factory_run_id, run.factory_run_id);
    assert.equal(candidate.provider_run_id, 'run-fake-provider-1');
    assert.equal(candidate.branch, 'stage1-smoke/candidate-demo');
    assert.equal(candidate.commit_sha, SHA_A);
    assert.equal(candidate.pr_number, 42);
    assert.equal(
      candidate.pr_url,
      'https://github.com/mac313248/jarvis-agencyos/pull/42'
    );
    assert.equal(candidate.ci_status, 'completed');
    assert.equal(candidate.ci_conclusion, 'success');
    assert.equal(candidate.evidence_at, '2026-08-11T01:00:00.000Z');

    const refreshed = await core.refreshCandidateLanding(
      candidate.candidate_id,
      fakeGithub()
    );
    assert.equal(refreshed.commit_sha, SHA_A);
    assert.equal(refreshed.pr_number, 42);
    assert.ok(refreshed.ci_ref.includes(SHA_A));

    const verified = await core.verifyCandidate(candidate.candidate_id, {
      githubClient: fakeGithub(),
      runTaskTests: async ({ commit_sha }) => {
        assert.equal(commit_sha, SHA_A);
        return { ok: true, name: 'task_tests', output: 'ok' };
      },
      runBuildChecks: async ({ commit_sha }) => {
        assert.equal(commit_sha, SHA_A);
        return { ok: true, name: 'build_typecheck_lint', output: 'ok' };
      },
      worker_claim: 'PASS',
    });
    assert.equal(verified.result, VERIFICATION_RESULT.PASS);
    assert.equal(verified.verification.commit_sha, SHA_A);
    assert.equal(verified.candidate.status, CANDIDATE_STATUS.VERIFIED);
    assert.equal(core.getTask(task.task_id).status, TASK_STATUS.VERIFIED);
    assert.equal(core.isVerificationAuthoritative(verified.verification.verification_id), true);
    core.close();
  });

  it('F: changing SHA invalidates old verification/approval', async () => {
    const { core, task, run } = makeCoreWithActiveRun();
    const candA = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'stage1-smoke/a',
      commit_sha: SHA_A,
      pr_number: 1,
      pr_url: 'https://example.test/pull/1',
    });
    const v = await core.verifyCandidate(candA.candidate_id, {
      runTaskTests: async () => ({ ok: true, output: 'ok' }),
    });
    const approval = core.recordApproval({
      task_id: task.task_id,
      approved_by: 'owner',
      candidate_id: candA.candidate_id,
      commit_sha: SHA_A,
    });
    assert.equal(approval.status, APPROVAL_STATUS.APPROVED);

    const candB = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'stage1-smoke/a',
      commit_sha: SHA_B,
      pr_number: 1,
      pr_url: 'https://example.test/pull/1',
    });
    assert.equal(candB.commit_sha, SHA_B);
    assert.equal(
      core.store.getCandidate(candA.candidate_id).status,
      CANDIDATE_STATUS.SUPERSEDED
    );
    assert.ok(core.store.getVerification(v.verification.verification_id).invalidated_at);
    assert.equal(
      core.isVerificationAuthoritative(v.verification.verification_id),
      false
    );
    assert.equal(
      core.store.getApproval(approval.approval_id).status,
      APPROVAL_STATUS.INVALIDATED
    );
    core.close();
  });

  it('G: stale/cancelled run cannot authorize candidate', async () => {
    const { core, task, run } = makeCoreWithActiveRun();
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
          commit_sha: SHA_A,
        }),
      (err) => err instanceof BuilderCoreError && err.code === 'STALE_RUN'
    );

    // Fresh run then mark stale before verify.
    const run2 = core.createRun({
      task_id: task.task_id,
      provider: 'cursor',
      provider_run_id: 'run-fake-provider-2',
    });
    core.store.updateRun(run2.factory_run_id, { status: RUN_STATUS.RUNNING });
    core._currentFactoryRunId = run2.factory_run_id;
    const cand = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run2.factory_run_id,
      branch: 'x',
      commit_sha: SHA_A,
    });
    core.markRunStale(run2.factory_run_id);
    await assert.rejects(
      () =>
        core.verifyCandidate(cand.candidate_id, {
          runTaskTests: async () => ({ ok: true, output: 'ok' }),
        }),
      (err) => err instanceof VerifierError && err.code === 'STALE_RUN'
    );
    core.close();
  });

  it('H: worker saying PASS cannot override failing verification', async () => {
    const { core, task, run } = makeCoreWithActiveRun();
    const cand = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'stage1-smoke/fail',
      commit_sha: SHA_A,
    });
    const verified = await core.verifyCandidate(cand.candidate_id, {
      githubClient: fakeGithub({ ciConclusion: 'failure' }),
      runTaskTests: async () => ({ ok: false, output: 'test failed' }),
      worker_claim: 'PASS — all good, ship it',
    });
    assert.equal(verified.result, VERIFICATION_RESULT.FAIL);
    assert.equal(verified.candidate.status, CANDIDATE_STATUS.REJECTED);
    assert.notEqual(core.getTask(task.task_id).status, TASK_STATUS.ACCEPTED);
    assert.equal(core.isVerificationAuthoritative(verified.verification.verification_id), false);
    const events = core.store.listEventsForTask(task.task_id);
    assert.ok(
      events.some(
        (e) =>
          e.event_type === EVENT_TYPE.VERIFICATION_RECORDED &&
          e.payload.worker_claim_ignored_for_authority === true
      )
    );
    core.close();
  });

  it('verification for SHA A cannot authorize SHA B', async () => {
    const { core, task, run } = makeCoreWithActiveRun();
    const cand = core.recordCandidate({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      branch: 'x',
      commit_sha: SHA_A,
    });
    await assert.rejects(
      async () => {
        // Simulate a buggy runner presenting the wrong SHA.
        const { assertExactShaBinding } = await import('../src/builder/verifier.js');
        assertExactShaBinding(cand, SHA_B);
      },
      (err) => err.code === 'SHA_MISMATCH'
    );
    core.close();
  });
});

describe('Stage-1 live GitHub candidate smoke (disposable PR)', () => {
  it('captures branch/SHA/PR/CI for a disposable draft PR (no merge)', async () => {
    // Requires authenticated gh + push access. Cleans up PR/branch afterward.
    let authOk = false;
    try {
      const status = execFileSync('gh', ['auth', 'status'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      authOk = /Logged in to github.com/i.test(status);
    } catch {
      authOk = false;
    }
    if (!authOk) {
      console.log('LIVE_CANDIDATE_SMOKE_BLOCKED reason=gh_auth_unavailable');
      return;
    }

    const repoRoot = new URL('..', import.meta.url).pathname;
    const stamp = Date.now();
    const branch = `stage1-smoke/candidate-${stamp}`;
    const work = mkdtempSync(join(tmpdir(), 'stage1-cand-'));
    let prNumber = null;
    let sha = null;
    let candidateId = null;

    try {
      // Disposable worktree from current HEAD — does not dirty the main checkout.
      execFileSync(
        'git',
        ['worktree', 'add', '-b', branch, work, 'HEAD'],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      writeFileSync(
        join(work, `artifacts/stage1-smoke-${stamp}.txt`),
        `stage1 candidate smoke ${stamp}\n`
      );
      execFileSync('git', ['add', `artifacts/stage1-smoke-${stamp}.txt`], {
        cwd: work,
        encoding: 'utf8',
      });
      execFileSync(
        'git',
        [
          '-c',
          'user.email=stage1-smoke@jarvis.local',
          '-c',
          'user.name=Stage1 Smoke',
          'commit',
          '-m',
          `stage1 smoke candidate ${stamp}`,
        ],
        { cwd: work, encoding: 'utf8' }
      );
      sha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: work,
        encoding: 'utf8',
      }).trim();
      assert.match(sha, /^[0-9a-f]{40}$/);

      execFileSync('git', ['push', '-u', 'origin', branch], {
        cwd: work,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const gh = createGhLandingClient({ cwd: repoRoot });
      const pr = gh.createDraftPullRequest({
        title: `[DO NOT MERGE] Stage-1 candidate smoke ${stamp}`,
        body: 'Disposable Stage-1 Builder smoke PR. Do not merge.',
        head: branch,
        base: 'main',
      });
      prNumber = pr.number;
      assert.ok(prNumber > 0);

      // Wait briefly for GitHub to index PR head.
      await new Promise((r) => setTimeout(r, 2000));
      const prInfo = await gh.getPullRequest(prNumber);
      assert.equal(prInfo.head_sha, sha);

      const { core, task, run } = makeCoreWithActiveRun();
      // Rebind provider ids for clarity in live evidence.
      core.store.updateRun(run.factory_run_id, {
        provider_run_id: `live-smoke-${stamp}`,
      });

      const candidate = core.recordCandidate({
        task_id: task.task_id,
        factory_run_id: run.factory_run_id,
        branch,
        commit_sha: sha,
        pr_number: pr.number,
        pr_url: pr.html_url,
        evidence_at: new Date().toISOString(),
      });
      candidateId = candidate.candidate_id;

      const landed = await core.refreshCandidateLanding(candidate.candidate_id, gh);
      assert.equal(landed.branch, branch);
      assert.equal(landed.commit_sha, sha);
      assert.equal(landed.pr_number, pr.number);
      assert.ok(landed.pr_url.includes(`/pull/${pr.number}`));
      assert.ok(landed.ci_status); // pending|completed|unknown
      assert.ok(landed.evidence_at);

      const verified = await core.verifyCandidate(candidate.candidate_id, {
        githubClient: gh,
        runTaskTests: async ({ commit_sha }) => ({
          ok: commit_sha === sha,
          name: 'exact_sha_binding',
          output: `bound=${commit_sha}`,
        }),
        // Live CI may still be pending on a brand-new draft PR; do not require success.
        worker_claim: 'PASS',
      });
      // With pending CI, authoritative github_ci ok=null + task test pass => PASS
      // if CI conclusion null is treated as unknown not fail. Our verifier treats
      // null ok as unknown; if only unknowns+passes => PASS when hardPasses>0.
      assert.ok(
        [VERIFICATION_RESULT.PASS, VERIFICATION_RESULT.BLOCKED].includes(
          verified.result
        )
      );
      assert.equal(verified.verification.commit_sha, sha);
      assert.equal(verified.task_accepted ?? false, false);

      // F live: SHA change invalidates.
      const shaB = execFileSync(
        'bash',
        ['-lc', `echo ${stamp}-b >> artifacts/stage1-smoke-${stamp}.txt && git add artifacts/stage1-smoke-${stamp}.txt && git -c user.email=stage1-smoke@jarvis.local -c user.name='Stage1 Smoke' commit -m 'stage1 smoke move sha' && git rev-parse HEAD`],
        { cwd: work, encoding: 'utf8' }
      ).trim().split('\n').at(-1);
      execFileSync('git', ['push', 'origin', branch], {
        cwd: work,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const candB = core.recordCandidate({
        task_id: task.task_id,
        factory_run_id: run.factory_run_id,
        branch,
        commit_sha: shaB,
        pr_number: pr.number,
        pr_url: pr.html_url,
      });
      assert.equal(candB.commit_sha, shaB);
      assert.equal(
        core.store.getCandidate(candidate.candidate_id).status,
        CANDIDATE_STATUS.SUPERSEDED
      );
      assert.equal(
        core.isVerificationAuthoritative(verified.verification.verification_id),
        false
      );

      console.log(
        'LIVE_CANDIDATE_SMOKE candidate_id=%s commit_sha=%s pr=%s ci=%s/%s',
        candidateId,
        sha,
        pr.number,
        landed.ci_status,
        landed.ci_conclusion
      );
      core.close();
    } finally {
      try {
        if (prNumber) {
          execFileSync(
            'gh',
            [
              'pr',
              'close',
              String(prNumber),
              '--repo',
              'mac313248/jarvis-agencyos',
              '--comment',
              'Stage-1 smoke complete; closing disposable PR (never merge).',
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
          );
        }
      } catch {}
      try {
        execFileSync('git', ['push', 'origin', '--delete', branch], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {}
      try {
        execFileSync('git', ['worktree', 'remove', '--force', work], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        try { rmSync(work, { recursive: true, force: true }); } catch {}
      }
      try {
        execFileSync('git', ['branch', '-D', branch], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {}
    }
  });
});
