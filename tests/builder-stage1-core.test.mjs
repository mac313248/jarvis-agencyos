// Stage-1 Builder Core — Build Order items 2–5.
// Covers: Jarvis Interface / Builder Core boundary, Stage-1 IDs/contracts,
// durable SQLite task/run/candidate/approval/event state, and immutable
// task-lock / acceptance / hash binding.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TRUST_DOMAIN,
  TASK_STATUS,
  RUN_STATUS,
  APPROVAL_STATUS,
  FAILURE_CLASS,
  EVENT_TYPE,
  newTaskId,
  newFactoryRunId,
  newCandidateId,
  newProposalId,
  newApprovalId,
  contentHash,
  taskContentHash,
  buildTaskLockPayload,
  assertTaskStatus,
  assertFailureClass,
  createBuilderCore,
  TaskLockError,
  openBuilderStore,
} from '../src/builder/index.js';
import {
  JARVIS_COMMANDS,
  createJarvisInterface,
  JarvisInterfaceError,
} from '../src/jarvis/index.js';

const SAMPLE_INTENT = {
  intent: 'Add Builder Stage-1 durable task lock',
  acceptance_ref: 'tests/builder-stage1-core.test.mjs#task-lock',
  allowed_paths: ['src/builder/', 'src/jarvis/', 'tests/builder-stage1-core.test.mjs'],
  tool_manifest: {
    providers: ['github', 'ref'],
    tools: ['repo_read'],
    mode: 'build',
  },
  review_required: true,
  priority: 10,
};

const SAMPLE_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('Stage-1 Builder Core (items 2–5)', () => {
  describe('boundary: Jarvis Interface vs Builder Core', () => {
    it('keeps distinct trust domains and refuses business-core authority', () => {
      const jarvis = createJarvisInterface();
      const status = jarvis.dispatch(JARVIS_COMMANDS.STATUS);
      assert.equal(jarvis.trustDomain, TRUST_DOMAIN.JARVIS_INTERFACE);
      assert.equal(jarvis.builder.trustDomain, TRUST_DOMAIN.BUILDER_CORE);
      assert.equal(status.trust_domain, TRUST_DOMAIN.JARVIS_INTERFACE);
      assert.equal(status.builder_trust_domain, TRUST_DOMAIN.BUILDER_CORE);
      assert.equal(
        status.authority.agencyos_business_core,
        'NOT_IN_STAGE1_SCOPE'
      );
      assert.notEqual(
        TRUST_DOMAIN.BUILDER_CORE,
        TRUST_DOMAIN.AGENCYOS_BUSINESS_CORE
      );
      jarvis.close();
    });

    it('delegates typed commands to Builder Core', () => {
      const jarvis = createJarvisInterface();
      const created = jarvis.dispatch(
        JARVIS_COMMANDS.CREATE_AND_LOCK_TASK,
        SAMPLE_INTENT
      );
      assert.equal(created.trust_domain, TRUST_DOMAIN.JARVIS_INTERFACE);
      assert.equal(created.delegated_to, TRUST_DOMAIN.BUILDER_CORE);
      assert.equal(created.result.status, TASK_STATUS.LOCKED);
      assert.ok(created.result.proposal_id);
      assert.ok(created.result.content_hash);
      jarvis.close();
    });

    it('fails closed on unknown commands', () => {
      const jarvis = createJarvisInterface();
      assert.throws(
        () => jarvis.dispatch('MERGE_TO_MAIN', {}),
        (err) => err instanceof JarvisInterfaceError
      );
      jarvis.close();
    });
  });

  describe('Stage-1 IDs and contracts', () => {
    it('mints distinct prefixed IDs', () => {
      const ids = [
        newTaskId(),
        newFactoryRunId(),
        newCandidateId(),
        newProposalId(),
        newApprovalId(),
      ];
      assert.ok(ids[0].startsWith('task_'));
      assert.ok(ids[1].startsWith('run_'));
      assert.ok(ids[2].startsWith('cand_'));
      assert.ok(ids[3].startsWith('prop_'));
      assert.ok(ids[4].startsWith('appr_'));
      assert.equal(new Set(ids).size, ids.length);
    });

    it('validates enums and stable content hashes', () => {
      assert.equal(assertTaskStatus(TASK_STATUS.LOCKED), TASK_STATUS.LOCKED);
      assert.equal(
        assertFailureClass(FAILURE_CLASS.ACCEPTANCE_TAMPER),
        FAILURE_CLASS.ACCEPTANCE_TAMPER
      );
      assert.throws(() => assertTaskStatus('DONE'));
      assert.throws(() => assertFailureClass('MEH'));

      const payload = buildTaskLockPayload({
        task_id: 'task_1',
        intent: 'x',
        intent_version: 1,
        acceptance_ref: 'a',
        allowed_paths: ['b/', 'a/'],
        tool_manifest: { providers: ['b', 'a'], tools: ['t2', 't1'], mode: 'build' },
        review_required: true,
      });
      const h1 = taskContentHash(payload);
      const h2 = taskContentHash(
        buildTaskLockPayload({
          task_id: 'task_1',
          intent: 'x',
          intent_version: 1,
          acceptance_ref: 'a',
          allowed_paths: ['a/', 'b/'],
          tool_manifest: { providers: ['a', 'b'], tools: ['t1', 't2'], mode: 'build' },
          review_required: true,
        })
      );
      assert.equal(h1, h2);
      assert.equal(h1, contentHash(payload));
      assert.match(h1, /^[0-9a-f]{64}$/);
    });
  });

  describe('durable task/run/candidate/approval/event state', () => {
    let dir;
    let dbPath;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'builder-stage1-'));
      dbPath = join(dir, 'builder.sqlite');
    });

    after(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    });

    it('persists and reconstructs nonterminal state across reopen', () => {
      const core1 = createBuilderCore({ dbPath });
      const task = core1.createAndLockTask(SAMPLE_INTENT);
      const run = core1.createRun({
        task_id: task.task_id,
        provider: 'cursor',
        provider_run_id: 'cursor-run-1',
      });
      const candidate = core1.recordCandidate({
        task_id: task.task_id,
        factory_run_id: run.factory_run_id,
        branch: 'phase-build/builder-stage-1-core',
        commit_sha: SAMPLE_COMMIT,
        pr_ref: 'pr/1',
      });
      const approval = core1.recordApproval({
        task_id: task.task_id,
        approved_by: 'owner',
        candidate_id: candidate.candidate_id,
        commit_sha: SAMPLE_COMMIT,
        status: APPROVAL_STATUS.APPROVED,
      });
      assert.equal(run.status, RUN_STATUS.PENDING);
      assert.equal(approval.proposal_id, task.proposal_id);
      assert.equal(approval.content_hash, task.content_hash);
      core1.close();

      const core2 = createBuilderCore({ dbPath });
      const reconstructed = core2.reconstruct();
      assert.equal(reconstructed.schema_version, 'builder-stage1-v3');
      assert.equal(reconstructed.nonterminal_tasks.length, 1);
      assert.equal(reconstructed.nonterminal_tasks[0].task_id, task.task_id);
      assert.equal(reconstructed.runs.length, 1);
      assert.equal(reconstructed.runs[0].factory_run_id, run.factory_run_id);
      assert.equal(reconstructed.candidates[0].candidate_id, candidate.candidate_id);
      assert.equal(reconstructed.approvals[0].approval_id, approval.approval_id);
      assert.ok(
        reconstructed.events.some((e) => e.event_type === EVENT_TYPE.TASK_LOCKED)
      );
      assert.ok(
        reconstructed.events.some((e) => e.event_type === EVENT_TYPE.APPROVAL_RECORDED)
      );
      core2.close();
    });

    it('stores events and rejects invalid failure classes at the store layer', () => {
      const store = openBuilderStore(':memory:');
      const task = store.insertTask({
        task_id: newTaskId(),
        intent: 'i',
        intent_version: 1,
        acceptance_ref: 'a',
        allowed_paths: ['src/'],
        tool_manifest: { providers: [], tools: [], mode: 'build' },
        review_required: true,
        status: TASK_STATUS.DRAFT,
      });
      assert.throws(() =>
        store.insertRun({
          factory_run_id: newFactoryRunId(),
          task_id: task.task_id,
          provider: 'cursor',
          attempt: 1,
          status: RUN_STATUS.FAILED,
          failure_class: 'NOT_A_CLASS',
        })
      );
      store.close();
    });
  });

  describe('task locking and immutable acceptance/hash binding', () => {
    it('locks owner intent into immutable proposal_id + content_hash', () => {
      const core = createBuilderCore();
      const draft = core.createDraftTask(SAMPLE_INTENT);
      assert.equal(draft.status, TASK_STATUS.DRAFT);
      assert.equal(draft.proposal_id, null);
      assert.equal(draft.content_hash, null);

      const locked = core.lockTask(draft.task_id);
      assert.equal(locked.status, TASK_STATUS.LOCKED);
      assert.ok(locked.proposal_id.startsWith('prop_'));
      assert.match(locked.content_hash, /^[0-9a-f]{64}$/);
      assert.ok(locked.locked_at);

      const expected = taskContentHash(
        buildTaskLockPayload({
          task_id: locked.task_id,
          intent: locked.intent,
          intent_version: locked.intent_version,
          acceptance_ref: locked.acceptance_ref,
          allowed_paths: locked.allowed_paths,
          tool_manifest: locked.tool_manifest,
          review_required: locked.review_required,
        })
      );
      assert.equal(locked.content_hash, expected);
      assert.equal(core.verifyLockedTask(locked.task_id).content_hash, expected);
      core.close();
    });

    it('rejects mutation of locked acceptance / paths / tools / intent', () => {
      const core = createBuilderCore();
      const locked = core.createAndLockTask(SAMPLE_INTENT);

      assert.throws(
        () =>
          core.attemptMutateLockedTask(locked.task_id, {
            acceptance_ref: 'tests/evil-pass.test.mjs',
          }),
        (err) =>
          err instanceof TaskLockError &&
          /immutable field 'acceptance_ref'/.test(err.message)
      );
      assert.throws(
        () =>
          core.attemptMutateLockedTask(locked.task_id, {
            allowed_paths: ['src/builder/', 'secrets/'],
          }),
        (err) => err instanceof TaskLockError
      );
      assert.throws(
        () =>
          core.attemptMutateLockedTask(locked.task_id, {
            tool_manifest: {
              providers: ['github', 'ref', 'evil'],
              tools: ['repo_read'],
              mode: 'build',
            },
          }),
        (err) => err instanceof TaskLockError
      );
      assert.throws(
        () =>
          core.attemptMutateLockedTask(locked.task_id, {
            intent: 'rewrite the finish line',
          }),
        (err) => err instanceof TaskLockError
      );
      assert.throws(
        () =>
          core.attemptMutateLockedTask(locked.task_id, {
            content_hash: '0'.repeat(64),
          }),
        (err) => err instanceof TaskLockError
      );

      // Status transitions that preserve the finish line remain allowed.
      const running = core.updateTaskStatus(locked.task_id, TASK_STATUS.RUNNING);
      assert.equal(running.status, TASK_STATUS.RUNNING);
      assert.equal(running.content_hash, locked.content_hash);
      core.close();
    });

    it('detects tampered locked finish-line fields via hash verification', () => {
      const store = openBuilderStore(':memory:');
      const core = createBuilderCore({ store });
      const locked = core.createAndLockTask(SAMPLE_INTENT);

      // Bypass Builder Core guards to simulate storage tampering.
      store.updateTask(locked.task_id, {
        acceptance_ref: 'tests/tampered.test.mjs',
      });

      assert.throws(
        () => core.verifyLockedTask(locked.task_id),
        (err) =>
          err instanceof TaskLockError &&
          /content_hash mismatch/.test(err.message)
      );
      assert.throws(
        () => core.createRun({ task_id: locked.task_id, provider: 'cursor' }),
        (err) => err instanceof TaskLockError
      );
      core.close();
    });

    it('requires lock before run creation', () => {
      const core = createBuilderCore();
      const draft = core.createDraftTask(SAMPLE_INTENT);
      assert.throws(
        () => core.createRun({ task_id: draft.task_id, provider: 'cursor' }),
        (err) => err instanceof TaskLockError
      );
      core.close();
    });

    it('binds approvals to exact proposal_id + content_hash', () => {
      const jarvis = createJarvisInterface();
      const { result: task } = jarvis.dispatch(
        JARVIS_COMMANDS.CREATE_AND_LOCK_TASK,
        SAMPLE_INTENT
      );
      const { result: run } = jarvis.dispatch(JARVIS_COMMANDS.CREATE_RUN, {
        task_id: task.task_id,
        provider: 'cursor',
        provider_run_id: 'prov_test_run_1',
        provider_agent_id: 'bc_test_agent_1',
      });
      const { result: candidate } = jarvis.dispatch(
        JARVIS_COMMANDS.RECORD_CANDIDATE,
        {
          task_id: task.task_id,
          factory_run_id: run.factory_run_id,
          branch: 'feature/x',
          commit_sha: SAMPLE_COMMIT,
          pr_number: 99,
          pr_url: 'https://github.com/mac313248/jarvis-agencyos/pull/99',
          ci_status: 'completed',
          ci_conclusion: 'success',
          evidence_at: '2026-08-11T00:00:00.000Z',
        }
      );
      assert.equal(candidate.provider_run_id, 'prov_test_run_1');
      assert.equal(candidate.commit_sha, SAMPLE_COMMIT);
      const { result: approval } = jarvis.dispatch(
        JARVIS_COMMANDS.RECORD_APPROVAL,
        {
          task_id: task.task_id,
          approved_by: 'owner',
          candidate_id: candidate.candidate_id,
          commit_sha: SAMPLE_COMMIT,
        }
      );
      assert.equal(approval.proposal_id, task.proposal_id);
      assert.equal(approval.content_hash, task.content_hash);
      assert.equal(approval.candidate_id, candidate.candidate_id);
      assert.equal(approval.commit_sha, SAMPLE_COMMIT);
      jarvis.close();
    });
  });
});
