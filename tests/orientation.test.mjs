// tests/orientation.test.mjs
// Read-only Release Gate Orientation Evaluator.
// Implementation-slice completion (F-01..F-14 file markers) stays separate
// from release-gate completion (SOT V1.0A/B/C/V1.1 test evidence at HEAD).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  FOUNDATION_SLICES,
  sliceHasEvidenceMarker,
  sliceIsComplete,
  determineNextSlice,
} from '../scripts/build-runner.mjs';
import {
  RELEASE_GATES,
  RELEASE_GATES_BY_ID,
  LIVE_VERIFICATION_ITEMS,
  ACTIVE_WORK_STATES,
  evaluateReleaseGates,
  buildOrientationBrief,
  persistOrientationEvidence,
  runOrientation,
  GATE_EVIDENCE_FILE,
} from '../scripts/orientation.mjs';

const REAL_ROOT = new URL('../', import.meta.url).pathname;
const REAL_SOT_DIR = join(REAL_ROOT, 'docs/master-sot');
const FIXTURE_ROOT = join(REAL_ROOT, '.tmp-build-runner-tests');

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeFixture({ completedSlices = [], onMain = false } = {}) {
  const root = join(FIXTURE_ROOT, 'or-' + Math.random().toString(36).slice(2) + '-' + Date.now());
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'docs/master-sot'), { recursive: true });
  for (const f of readdirSync(REAL_SOT_DIR)) {
    copyFileSync(join(REAL_SOT_DIR, f), join(root, 'docs/master-sot', f));
  }
  writeFileSync(join(root, 'AGENTS.md'), '# AGENTS.md stub\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'jarvis-agencyos', version: '0.0.0-test', private: true, type: 'module',
    scripts: { test: 'node --test tests/*.test.mjs' },
  }) + '\n');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/verify-sot.mjs'), '// stub\n');
  mkdirSync(join(root, 'migrations'), { recursive: true });
  mkdirSync(join(root, 'src/contracts'), { recursive: true });
  mkdirSync(join(root, 'src/runtime'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(
    join(root, 'tests/smoke.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
    "test('smoke', () => assert.equal(1, 1));\n"
  );
  for (const id of completedSlices) {
    const slice = FOUNDATION_SLICES.find((s) => s.phase_id === id);
    if (slice) {
      const p = join(root, slice.evidence_marker);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, '// evidence\n');
    }
  }
  git(root, ['init', '-q', '-b', onMain ? 'main' : 'phase-build/orientation-fixture']);
  git(root, ['add', '-A']);
  git(root, ['config', 'user.email', 'test@local']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  return root;
}

function passAll(_root, command) {
  return {
    ok: true,
    name: command.name,
    argv: command.argv || ['npm', 'run', command.name],
    exit_code: 0,
    failed: 0,
    passed: 1,
    raw: 'PASS',
  };
}

function failNamed(failName) {
  return (_root, command) => ({
    ok: command.name !== failName,
    name: command.name,
    argv: command.argv || ['npm', 'run', command.name],
    exit_code: command.name === failName ? 1 : 0,
    failed: command.name === failName ? 1 : 0,
    passed: command.name === failName ? 0 : 1,
    raw: command.name === failName ? 'FAIL' : 'PASS',
  });
}

test('RELEASE_GATES maps SOT release names without replacing F-slices', () => {
  const ids = RELEASE_GATES.map((g) => g.gate_id);
  assert.deepEqual(ids, ['BUILDER_STAGE_1', 'V1.0A', 'V1.0B', 'V1.0C', 'V1.0D', 'V1.1']);
  assert.equal(RELEASE_GATES_BY_ID['V1.0A'].phase_name, 'Read-Safe Foundation');
  for (const g of RELEASE_GATES) {
    assert.equal(g.business_write_autonomy, 'DISABLED');
    assert.ok(Array.isArray(g.sot_references) && g.sot_references.length > 0);
    assert.ok(Array.isArray(g.verify_commands));
    assert.ok(Array.isArray(g.acceptance_tests));
    assert.ok(Array.isArray(g.requires));
    assert.ok(Array.isArray(g.unblocks));
  }
  assert.ok(FOUNDATION_SLICES.some((s) => s.phase_id === 'F-01'));
  assert.equal(FOUNDATION_SLICES.some((s) => s.phase_id === 'V1.0A'), false);
});

test('implementation-slice completion stays file-marker based', () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id) });
  try {
    for (const slice of FOUNDATION_SLICES) {
      assert.equal(sliceHasEvidenceMarker(root, slice), true, slice.phase_id);
      assert.equal(sliceIsComplete(root, slice), true, 'alias ' + slice.phase_id);
    }
    assert.equal(determineNextSlice(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release-gate evaluation uses command results, not F-slice file existence', async () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id) });
  try {
    const gates = await evaluateReleaseGates(root, { runCommand: failNamed('test:v1.0a-postgres') });
    const v10a = gates.find((g) => g.gate_id === 'V1.0A');
    assert.equal(v10a.test_result, 'FAIL');
    assert.equal(determineNextSlice(root), null, 'slice complete must remain independent of gate FAIL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('marker-complete slices are not confused with release-gate PASS', async () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id) });
  try {
    const brief = await buildOrientationBrief(root, {
      runCommand: failNamed('test:v1.0a-postgres'),
    });
    assert.equal(brief.completed_implementation_slices.length, FOUNDATION_SLICES.length);
    assert.equal(brief.completed_deterministic_gates.includes('V1.0A'), false);
    assert.equal(brief.implementation_slices.marker_complete_is_not_release_gate_pass, true);
    assert.equal(brief.active_work_state, ACTIVE_WORK_STATES.GATE_REPAIR);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('V1.0B is BLOCKED until V1.0A tests pass', async () => {
  const root = makeFixture({ completedSlices: [] });
  try {
    const gates = await evaluateReleaseGates(root, { runCommand: failNamed('test:v1.0a-postgres') });
    const v10b = gates.find((g) => g.gate_id === 'V1.0B');
    assert.equal(v10b.test_result, 'BLOCKED');
    assert.ok(v10b.blockers.some((b) => /V1\.0A/.test(b)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('V1.0D is NOT_REQUIRED unless a durable workflow is selected', async () => {
  const root = makeFixture();
  try {
    const gates = await evaluateReleaseGates(root, { runCommand: passAll });
    const v10d = gates.find((g) => g.gate_id === 'V1.0D');
    assert.equal(v10d.test_result, 'NOT_REQUIRED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('V1.1 stays WAITING_ON_OWNER until a T2 routine is selected', async () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id) });
  try {
    const gates = await evaluateReleaseGates(root, { runCommand: passAll });
    const v11 = gates.find((g) => g.gate_id === 'V1.1');
    assert.equal(v11.test_result, 'WAITING_ON_OWNER');
    assert.equal(v11.owner_gate, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('future candidate phase is not reported as already active', async () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id), onMain: true });
  try {
    const brief = await buildOrientationBrief(root, { runCommand: passAll });
    assert.equal(brief.next_phase_candidate, 'V1.1');
    assert.notEqual(brief.active_work_state, 'V1.1');
    assert.equal(brief.current_phase, undefined);
    assert.equal(brief.active_work_state, ACTIVE_WORK_STATES.LIVE_VERIFICATION_CLOSURE);
    assert.ok(brief.completed_deterministic_gates.includes('V1.0C'));
    assert.equal(brief.completed_deterministic_gates.includes('V1.1'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('orientation brief answers automation questions and never dispatches', async () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id), onMain: true });
  try {
    const brief = await buildOrientationBrief(root, { runCommand: passAll });
    assert.ok(/^[0-9a-f]{40}$/.test(brief.head_sha));
    assert.ok(typeof brief.sot_manifest_sha256 === 'string' && brief.sot_manifest_sha256.length === 64);
    assert.equal(brief.business_write_autonomy, 'DISABLED');
    assert.ok(Array.isArray(brief.ready_work) && brief.ready_work.length > 0);
    assert.equal(brief.claim_task.dispatch, false);
    assert.equal(brief.claim_task.via, 'EXECUTE_SOFTWARE_TASK');
    assert.equal(brief.claim_task.command, 'node scripts/jarvis-task.mjs');
    assert.match(brief.claim_task.reason, /Postgres \/ tenant boundary/);
    assert.ok(brief.completion_proof);
    assert.ok(Array.isArray(brief.unblocks_after));
    assert.equal(brief.advance_allowed, false);
    assert.ok(brief.advance_blockers.length > 0);
    assert.equal(brief.implementation_slices.status, 'V1_0_COMPLETE');
    assert.equal(brief.implementation_slices.next, null);
    assert.equal(brief.dispatch, false);
    assert.equal(brief.persist_evidence, false);
    assert.equal(brief.evidence_path, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('next incomplete F-slice is the claimable task via existing run-next-phase', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const brief = await buildOrientationBrief(root, { runCommand: passAll });
    assert.equal(brief.implementation_slices.next.phase_id, 'F-02');
    assert.equal(brief.active_work_state, ACTIVE_WORK_STATES.FOUNDATION_SLICE);
    assert.equal(brief.claim_task.via, 'run-next-phase');
    assert.equal(brief.claim_task.command, './scripts/run-next-phase');
    assert.equal(brief.claim_task.dispatch, false);
    assert.equal(brief.claim_task.contract.phase_id, 'F-02');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('live verification items reuse SOT 04 and are not a new task queue', () => {
  const ids = LIVE_VERIFICATION_ITEMS.map((i) => i.id);
  assert.ok(ids.includes('inbound-events'));
  assert.ok(ids.includes('owner-authentication'));
  assert.ok(ids.includes('read-only-connectors'));
  for (const item of LIVE_VERIFICATION_ITEMS) {
    assert.match(item.sot_ref, /04_LIVE_VERIFICATION_BACKLOG/);
    assert.ok(['OPEN', 'CONDITIONAL', 'OWNER_THRESHOLD', 'NOT_BLOCKER'].includes(item.live_status));
  }
});

test('default orientation performs no repository writes', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const before = git(root, ['status', '--porcelain']);
    const head = git(root, ['rev-parse', 'HEAD']);
    const brief = await runOrientation(root, { runCommand: passAll });
    const after = git(root, ['status', '--porcelain']);
    assert.equal(before, '');
    assert.equal(after, '');
    assert.equal(git(root, ['rev-parse', 'HEAD']), head);
    assert.equal(existsSync(join(root, 'artifacts/orientation')), false);
    assert.equal(existsSync(join(root, GATE_EVIDENCE_FILE)), false);
    assert.equal(brief.persist_evidence, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('orientation results are bound to current HEAD SHA', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const head = git(root, ['rev-parse', 'HEAD']);
    const brief = await buildOrientationBrief(root, { runCommand: passAll });
    assert.equal(brief.head_sha, head);
    assert.match(brief.evaluation_id, new RegExp('^eval_' + head.slice(0, 12)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('open live-verification blockers force advance_allowed false', async () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id) });
  try {
    const brief = await buildOrientationBrief(root, { runCommand: passAll });
    assert.equal(brief.advance_allowed, false);
    assert.ok(brief.live_verification_blockers.includes('postgres-tenant-boundary'));
    assert.ok(brief.advance_blockers.some((b) => /live verification backlog remains/.test(b)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('owner blockers force advance_allowed false', async () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id) });
  try {
    const brief = await buildOrientationBrief(root, { runCommand: passAll });
    assert.equal(brief.advance_allowed, false);
    assert.ok(brief.owner_blockers.some((b) => /first bounded T2/.test(b)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('green unit suites alone do not silently clear live blockers', async () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id) });
  try {
    const brief = await buildOrientationBrief(root, { runCommand: passAll });
    assert.ok(brief.completed_deterministic_gates.includes('V1.0A'));
    assert.ok(brief.completed_deterministic_gates.includes('V1.0B'));
    assert.ok(brief.completed_deterministic_gates.includes('V1.0C'));
    assert.ok(brief.live_verification_blockers.length > 0);
    assert.equal(brief.advance_allowed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('persisted evidence is explicit and SHA/evaluation-scoped', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const brief = await buildOrientationBrief(root, {
      runCommand: passAll,
      persistEvidence: true,
    });
    const expected = join(
      root,
      'artifacts/orientation',
      brief.head_sha,
      brief.evaluation_id + '.json'
    );
    assert.equal(existsSync(expected), true);
    assert.equal(existsSync(join(root, GATE_EVIDENCE_FILE)), false);
    const evidence = JSON.parse(readFileSync(expected, 'utf8'));
    assert.equal(evidence.head_sha, brief.head_sha);
    assert.equal(evidence.evaluation_id, brief.evaluation_id);
    assert.ok(Array.isArray(evidence.commands_executed));
    assert.ok(Array.isArray(evidence.exit_codes));
    assert.ok(Array.isArray(evidence.acceptance_tests));
    assert.ok(Array.isArray(evidence.live_verification_blockers));
    assert.ok(Array.isArray(evidence.owner_blockers));
    assert.equal(typeof evidence.evaluated_at, 'string');
    assert.equal(evidence.advance_allowed, false);
    assert.equal(evidence.evidence_classification.live_verification.includes('not cleared by unit suites'), true);
    assert.equal(brief.evidence_path, join('artifacts/orientation', brief.head_sha, brief.evaluation_id + '.json'));
    assert.throws(
      () => persistOrientationEvidence(root, brief),
      /refusing to overwrite immutable orientation evidence/
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('orientation is allowed on protected main and does not create a phase branch', async () => {
  const root = makeFixture({ onMain: true });
  try {
    const brief = await buildOrientationBrief(root, { runCommand: passAll });
    assert.ok(brief.head_sha);
    const branch = git(root, ['branch', '--show-current']);
    assert.equal(branch, 'main');
    const branches = git(root, ['branch']);
    assert.doesNotMatch(branches, /phase-build\//);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
