// tests/build-runner.test.mjs
// Focused tests for the local build runner (scripts/build-runner.mjs).
// Runs against throwaway temp mini-repos so the REAL repo is never mutated.
// The SOT-mismatch test additionally asserts the real repo's SOT is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  run, parseVerdict, parseReviewResult, verifySot, verifyGitState, determineNextSlice,
  validatePhaseContract, loadState, saveState, defaultCursorInvoker,
  defaultCodexInvoker, FOUNDATION_SLICES, APPROVED_MANIFEST_SHA256,
  TERMINAL_STOP_STATES, CURSOR_AGENT_BIN,
  isDryRunOwnerCheckpoint, BuildRunnerError, formatStatusReport,
  acquireRunLock,
} from '../scripts/build-runner.mjs';

const REAL_ROOT = new URL('../', import.meta.url).pathname;
const REAL_SOT_DIR = join(REAL_ROOT, 'docs/master-sot');
// Workspace-local fixtures: writable in sandbox and on Linux CI (not /private/tmp).
const FIXTURE_ROOT = join(REAL_ROOT, '.tmp-build-runner-tests');
const review = (verdict, blockers = []) => JSON.stringify({ verdict, blockers });

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
function sha256Dir(dir) {
  const h = createHash('sha256');
  for (const f of readdirSync(dir).sort()) {
    h.update(f);
    h.update(sha256File(join(dir, f)));
  }
  return h.digest('hex');
}
function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeFixture({ dirty = false, tamperManifest = false, completedSlices = [] } = {}) {
  const root = join(FIXTURE_ROOT, 'br-' + Math.random().toString(36).slice(2) + '-' + Date.now());
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'docs/master-sot'), { recursive: true });
  for (const f of readdirSync(REAL_SOT_DIR)) {
    copyFileSync(join(REAL_SOT_DIR, f), join(root, 'docs/master-sot', f));
  }
  writeFileSync(join(root, 'AGENTS.md'), '# AGENTS.md stub\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'jarvis-agencyos', version: '0.0.0-test', private: true,
    type: 'module', scripts: { test: 'node --test tests/*.test.mjs' },
  }) + '\n');
  writeFileSync(join(root, '.gitignore'),
    'artifacts/\n');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/verify-sot.mjs'), '// stub\n');
  mkdirSync(join(root, 'migrations'), { recursive: true });
  mkdirSync(join(root, 'src/contracts'), { recursive: true });
  mkdirSync(join(root, 'src/runtime'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests/smoke.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
    "test('smoke', () => assert.equal(1, 1));\n");
  for (const id of completedSlices) {
    const slice = FOUNDATION_SLICES.find((s) => s.phase_id === id);
    if (slice) {
      const p = join(root, slice.evidence_marker);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, '// evidence\n');
    }
  }
  if (tamperManifest) {
    const mp = join(root, 'docs/master-sot/SOT_SYNC_MANIFEST.sha256');
    const lines = readFileSync(mp, 'utf8').split('\n');
    const name = lines[0].split(/\s+/).filter(Boolean)[1];
    lines[0] = '0'.repeat(64) + '  ' + name;
    writeFileSync(mp, lines.join('\n'));
  }
  git(root, ['init', '-q', '-b', 'phase-2/governed-capability-registry']);
  git(root, ['add', '-A']);
  git(root, ['config', 'user.email', 'test@local']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  if (dirty) writeFileSync(join(root, 'dirty.txt'), 'dirty\n');
  return root;
}

function mockCursor() {
  const calls = [];
  return { invoker: (root, prompt) => { calls.push({ root, prompt }); return 'writer done'; }, calls };
}
function passingTests() { return () => ({ ok: true, passed: 1, failed: 0, raw: '# pass 1\n# fail 0' }); }
function failingTests() { return () => ({ ok: false, passed: 0, failed: 1, raw: '# fail 1' }); }
function completedThrough(phaseId) {
  const index = FOUNDATION_SLICES.findIndex((slice) => slice.phase_id === phaseId);
  assert.notEqual(index, -1, 'unknown phase ' + phaseId);
  return FOUNDATION_SLICES.slice(0, index + 1).map((slice) => slice.phase_id);
}

// 1. Dry-run: contracts next slice, no app changes, stops at WAITING_ON_OWNER
test('dry-run contracts next slice and stops at WAITING_ON_OWNER', async () => {
  const root = makeFixture({ completedSlices: ['F-01','F-02','F-03','F-04','F-05','F-06','F-07'] });
  try {
    const state = await run(root, { dryRun: true });
    assert.equal(state.status, 'WAITING_ON_OWNER');
    assert.equal(state.dry_run_checkpoint, true);
    assert.equal(isDryRunOwnerCheckpoint(state), true);
    assert.equal(state.current_phase_id, 'F-08');
    const contract = JSON.parse(readFileSync(join(root, 'artifacts/build-runner/current-phase.json'), 'utf8'));
    assert.equal(contract.phase_id, 'F-08');
    assert.equal(contract.business_write_autonomy, 'DISABLED');
    assert.ok(/^[0-9a-f]{40}$/.test(contract.base_sha));
    for (const k of ['phase_name','scope','non_scope','sot_references','acceptance_tests','stop_conditions']) {
      assert.ok(k in contract, 'missing ' + k);
    }
    assert.equal(existsSync(join(root, 'src/runtime/trusted-executor.js')), false);
    assert.equal(state.phase_branch, null);
    assert.ok(TERMINAL_STOP_STATES.includes(state.status));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 2. Resume: state.json persists and is reloaded
test('resume: state.json persists and is reloaded', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const s1 = await run(root, { dryRun: true });
    assert.equal(s1.status, 'WAITING_ON_OWNER');
    const persisted = loadState(root);
    assert.equal(persisted.status, 'WAITING_ON_OWNER');
    assert.equal(persisted.dry_run_checkpoint, true);
    assert.equal(persisted.current_phase_id, s1.current_phase_id);
    const s2 = await run(root, { dryRun: true });
    assert.equal(s2.status, 'WAITING_ON_OWNER');
    assert.equal(s2.current_phase_id, s1.current_phase_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Dry-run checkpoint must not permanently block a later normal mocked run.
test('dry-run then normal run resumes with injected mocks (no app phase files)', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const dry = await run(root, { dryRun: true });
    assert.equal(dry.status, 'WAITING_ON_OWNER');
    assert.equal(dry.dry_run_checkpoint, true);
    assert.equal(dry.current_phase_id, 'F-02');
    assert.equal(existsSync(join(root, 'migrations/0003_owner_auth.sql')), false);

    const c = mockCursor();
    let codexCalls = 0;
    const state = await run(root, {
      cursorInvoker: c.invoker,
      codexInvoker: () => { codexCalls++; return review('PASS'); },
      testRunner: passingTests(),
    });
    assert.equal(state.status, 'READY_FOR_NEXT_V1_0_SLICE');
    assert.equal(state.dry_run_checkpoint, false);
    assert.equal(c.calls.length, 1);
    assert.equal(codexCalls, 1);
    assert.equal(state.codex_verdicts.join(','), 'PASS');
    // Mocks must not materialize the real application-phase evidence marker.
    assert.equal(existsSync(join(root, 'migrations/0003_owner_auth.sql')), false);
    assert.equal(existsSync(join(root, 'src/runtime/trusted-executor.js')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('genuine WAITING_ON_OWNER (dry_run_checkpoint:false) stays permanent', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    saveState(root, {
      ...loadState(root),
      status: 'WAITING_ON_OWNER',
      dry_run_checkpoint: false,
      current_phase_id: 'F-02',
    });
    const c = mockCursor();
    let codexCalls = 0;
    const state = await run(root, {
      cursorInvoker: c.invoker,
      codexInvoker: () => { codexCalls++; return review('PASS'); },
      testRunner: passingTests(),
    });
    assert.equal(state.status, 'WAITING_ON_OWNER');
    assert.equal(c.calls.length, 0);
    assert.equal(codexCalls, 0);
    assert.equal(isDryRunOwnerCheckpoint(state), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy dry-run WAITING_ON_OWNER without dry_run_checkpoint field resumes', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    mkdirSync(join(root, 'artifacts/build-runner'), { recursive: true });
    // Pre-repair shape: no dry_run_checkpoint key (must not be defaulted to false).
    writeFileSync(join(root, 'artifacts/build-runner/state.json'), JSON.stringify({
      status: 'WAITING_ON_OWNER',
      last_accepted_sha: null,
      current_phase_id: 'F-02',
      phase_branch: null,
      cursor_runs: 0,
      codex_verdicts: [],
      last_verdict: null,
    }) + '\n');
    const loaded = loadState(root);
    assert.equal('dry_run_checkpoint' in loaded, false);
    assert.equal(isDryRunOwnerCheckpoint(loaded), true);
    const c = mockCursor();
    const state = await run(root, {
      cursorInvoker: c.invoker,
      codexInvoker: () => review('PASS'),
      testRunner: passingTests(),
    });
    assert.equal(state.status, 'READY_FOR_NEXT_V1_0_SLICE');
    assert.equal(c.calls.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 3. Malformed review is a protocol error, not an acceptance failure
test('malformed review stops at REVIEW_PROTOCOL_ERROR', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const c = mockCursor();
    const codex = () => 'I think the code looks fine';
    const state = await run(root, { cursorInvoker: c.invoker, codexInvoker: codex, testRunner: passingTests() });
    assert.equal(state.status, 'REVIEW_PROTOCOL_ERROR');
    assert.equal(state.last_verdict, 'REVIEW_PROTOCOL_ERROR');
    assert.equal(state.codex_verdicts.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 4. PASS_WITH_FIXES bound: one repair, second verdict must be PASS
test('PASS_WITH_FIXES then PASS accepts the phase', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const c = mockCursor();
    let n = 0;
    const codex = () => { n++; return n === 1 ? review('PASS_WITH_FIXES', ['fix']) : review('PASS'); };
    const state = await run(root, { cursorInvoker: c.invoker, codexInvoker: codex, testRunner: passingTests() });
    assert.equal(state.status, 'READY_FOR_NEXT_V1_0_SLICE');
    assert.deepEqual(state.codex_verdicts, ['PASS_WITH_FIXES', 'PASS']);
    assert.equal(c.calls.length, 2, 'exactly one repair Cursor cycle');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PASS_WITH_FIXES twice fails closed (no 3rd cycle)', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const c = mockCursor();
    const codex = () => review('PASS_WITH_FIXES', ['fix']);
    const state = await run(root, { cursorInvoker: c.invoker, codexInvoker: codex, testRunner: passingTests() });
    assert.equal(state.status, 'FAILED_ACCEPTANCE_GATE');
    assert.equal(state.codex_verdicts.length, 2, 'max two verdicts');
    assert.equal(c.calls.length, 2, 'no third repair cycle');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 5. Max two verdicts
test('FAIL on first verdict fails closed', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const c = mockCursor();
    const blockers = [
      'allocateFunctionId mutates before assertWritersAllowed',
      'UNKNOWN/AMBIGUOUS treated as terminal ERROR',
    ];
    const codex = () => review('FAIL', blockers);
    const state = await run(root, { cursorInvoker: c.invoker, codexInvoker: codex, testRunner: passingTests() });
    assert.equal(state.status, 'FAILED_ACCEPTANCE_GATE');
    assert.equal(state.codex_verdicts.length, 1);
    assert.deepEqual(state.blockers, blockers);
    const report = formatStatusReport(state);
    assert.match(report, /allocateFunctionId mutates before assertWritersAllowed/);
    assert.match(report, /UNKNOWN\/AMBIGUOUS treated as terminal ERROR/);
    assert.doesNotMatch(report, /blockers:\s*2\s*$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FAILED_ACCEPTANCE_GATE durable report includes actual blockers; terminal re-run does not replay Cursor', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const c = mockCursor();
    const blockers = [
      'DBOS effect-bound steps accept arbitrary adapters',
      'migration 0013 in-place edit skipped for existing DBs',
    ];
    const state = await run(root, {
      cursorInvoker: c.invoker,
      codexInvoker: () => review('FAIL', blockers),
      testRunner: passingTests(),
    });
    assert.equal(state.status, 'FAILED_ACCEPTANCE_GATE');
    assert.deepEqual(state.blockers, blockers);
    assert.equal(c.calls.length, 1);

    const durable = loadState(root);
    assert.deepEqual(durable.blockers, blockers);
    const report = formatStatusReport(durable);
    assert.match(report, /FAILED_ACCEPTANCE_GATE/);
    assert.match(report, /DBOS effect-bound steps accept arbitrary adapters/);
    assert.match(report, /migration 0013 in-place edit skipped for existing DBs/);
    // Must list the blockers themselves, not only a generic count.
    assert.ok(report.includes(blockers[0]));
    assert.ok(report.includes(blockers[1]));

    const c2 = mockCursor();
    let codexCalls = 0;
    const again = await run(root, {
      cursorInvoker: c2.invoker,
      codexInvoker: () => { codexCalls++; return review('PASS'); },
      testRunner: passingTests(),
    });
    assert.equal(again.status, 'FAILED_ACCEPTANCE_GATE');
    assert.deepEqual(again.blockers, blockers);
    assert.equal(c2.calls.length, 0, 'no duplicate Cursor replay on terminal FAILED_ACCEPTANCE_GATE');
    assert.equal(codexCalls, 0, 'no Codex replay on terminal stop');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PASS_WITH_FIXES then FAIL persists second-verdict blockers', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const c = mockCursor();
    let n = 0;
    const secondBlockers = ['remaining freeze-gate hole', 'ambiguous postcondition still terminal'];
    const codex = () => {
      n++;
      return n === 1
        ? review('PASS_WITH_FIXES', ['first pass issues'])
        : review('FAIL', secondBlockers);
    };
    const state = await run(root, { cursorInvoker: c.invoker, codexInvoker: codex, testRunner: passingTests() });
    assert.equal(state.status, 'FAILED_ACCEPTANCE_GATE');
    assert.deepEqual(state.blockers, secondBlockers);
    assert.equal(c.calls.length, 2, 'exactly one repair cycle, no third Cursor replay');
    const report = formatStatusReport(state);
    assert.match(report, /remaining freeze-gate hole/);
    assert.match(report, /ambiguous postcondition still terminal/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tests failing before review fails closed (no Codex call)', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const c = mockCursor();
    let codexCalled = 0;
    const codex = () => { codexCalled++; return 'PASS'; };
    const state = await run(root, { cursorInvoker: c.invoker, codexInvoker: codex, testRunner: failingTests() });
    assert.equal(state.status, 'FAILED_ACCEPTANCE_GATE');
    assert.equal(codexCalled, 0, 'Codex must not run when tests fail');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 6. Dirty Git refusal (identical for dry-run and normal mode)
test('dirty Git state is refused', () => {
  const root = makeFixture({ dirty: true });
  try {
    assert.throws(() => verifyGitState(root), (e) => e instanceof BuildRunnerError && e.code === 'DIRTY_GIT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clean + dry-run succeeds', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const state = await run(root, { dryRun: true });
    assert.equal(state.status, 'WAITING_ON_OWNER');
    assert.equal(state.dry_run_checkpoint, true);
    assert.equal(state.current_phase_id, 'F-02');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dirty + dry-run fails closed before phase work (no writers)', async () => {
  const root = makeFixture({ dirty: true });
  try {
    let cursorCalls = 0;
    let codexCalls = 0;
    await assert.rejects(
      () => run(root, {
        dryRun: true,
        cursorInvoker: () => { cursorCalls++; return 'writer'; },
        codexInvoker: () => { codexCalls++; return review('PASS'); },
        testRunner: passingTests(),
      }),
      (e) => e instanceof BuildRunnerError && e.code === 'DIRTY_GIT'
    );
    assert.equal(cursorCalls, 0, 'Cursor must not run after dirty rejection');
    assert.equal(codexCalls, 0, 'Codex must not run after dirty rejection');
    assert.equal(existsSync(join(root, 'artifacts/build-runner/current-phase.json')), false);
    assert.equal(existsSync(join(root, 'artifacts/build-runner/state.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dirty + normal mode fails closed before phase work (no writers)', async () => {
  const root = makeFixture({ dirty: true });
  try {
    let cursorCalls = 0;
    let codexCalls = 0;
    await assert.rejects(
      () => run(root, {
        cursorInvoker: () => { cursorCalls++; return 'writer'; },
        codexInvoker: () => { codexCalls++; return review('PASS'); },
        testRunner: passingTests(),
      }),
      (e) => e instanceof BuildRunnerError && e.code === 'DIRTY_GIT'
    );
    assert.equal(cursorCalls, 0, 'Cursor must not run after dirty rejection');
    assert.equal(codexCalls, 0, 'Codex must not run after dirty rejection');
    assert.equal(existsSync(join(root, 'artifacts/build-runner/current-phase.json')), false);
    assert.equal(existsSync(join(root, 'artifacts/build-runner/state.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run refuses on protected main branch', async () => {
  const root = makeFixture();
  try {
    git(root, ['checkout', '-b', 'main', '-q']);
    await assert.rejects(() => run(root, { dryRun: true }), (e) =>
      e instanceof BuildRunnerError && e.code === 'ON_PROTECTED_BRANCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 7. SOT mismatch refusal WITHOUT changing the real SOT
test('SOT mismatch refuses and leaves real SOT unchanged', async () => {
  const before = sha256Dir(REAL_SOT_DIR);
  const root = makeFixture({ tamperManifest: true });
  try {
    await assert.rejects(() => verifySot(root), (e) =>
      e instanceof BuildRunnerError && (e.code === 'SOT_MISMATCH' || e.code === 'SOT_MANIFEST_NOT_APPROVED'));
    const after = sha256Dir(REAL_SOT_DIR);
    assert.equal(after, before, 'real SOT was modified by the mismatch path');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approved manifest hash constant matches the real repo', async () => {
  const v = await verifySot(REAL_ROOT);
  assert.equal(v.ok, true);
  assert.equal(v.manifestHash, APPROVED_MANIFEST_SHA256);
});

// 8. Business-write autonomy invariant: always DISABLED
test('every foundation slice has business_write_autonomy DISABLED', () => {
  for (const s of FOUNDATION_SLICES) assert.equal(s.business_write_autonomy, 'DISABLED', s.phase_id);
});

test('validatePhaseContract rejects non-DISABLED autonomy', () => {
  const good = {
    phase_id: 'X', phase_name: 'x', base_sha: 'a', scope: 's', non_scope: 'n',
    sot_references: [], acceptance_tests: [], stop_conditions: [],
    business_write_autonomy: 'DISABLED',
  };
  assert.doesNotThrow(() => validatePhaseContract(good));
  const bad = { ...good, business_write_autonomy: 'ENABLED' };
  assert.throws(() => validatePhaseContract(bad), (e) =>
    e instanceof BuildRunnerError && e.code === 'BUSINESS_WRITE_AUTONOMY_INVARIANT');
});

// 9. No auto-merge: runner never merges to main
test('runner never merges to main', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const c = mockCursor();
    const codex = () => review('PASS');
    const state = await run(root, { cursorInvoker: c.invoker, codexInvoker: codex, testRunner: passingTests() });
    assert.equal(state.status, 'READY_FOR_NEXT_V1_0_SLICE');
    let mainExists = false;
    try { git(root, ['rev-parse', '--verify', 'main']); mainExists = true; } catch (e) { mainExists = false; }
    assert.equal(mainExists, false, 'main branch must not be created or merged into');
    const cur = git(root, ['branch', '--show-current']);
    assert.match(cur, /^(phase-2|phase-build)\//);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 10. Native local-authenticated Cursor CLI; no credential materialization
test('defaultCursorInvoker uses native headless agent flags with no secret env', () => {
  let captured = null;
  const out = defaultCursorInvoker('/tmp/ws', 'do the work', {
    agentBin: 'agent-mock',
    execFileSync: (bin, argv, opts) => {
      captured = { bin, argv, opts };
      return '{"ok":true}';
    },
  });
  assert.equal(out, '{"ok":true}');
  assert.equal(captured.bin, 'agent-mock');
  assert.deepEqual(captured.argv, ['--print', '--output-format', 'stream-json', '--workspace', '/tmp/ws', '--trust', '--force', '--sandbox', 'disabled', 'do the work']);
  assert.equal(captured.opts.env, undefined);
  assert.equal(CURSOR_AGENT_BIN, 'agent');
});

test('defaultCodexInvoker uses read-only never-approval ephemeral json form', () => {
  let captured = null;
  defaultCodexInvoker('/repo', 'review please', {
    codexBin: 'codex-mock',
    execFileSync: (bin, argv) => {
      captured = { bin, argv };
      return 'PASS\n';
    },
  });
  assert.equal(captured.bin, 'codex-mock');
  assert.deepEqual(captured.argv, [
    'exec', '-C', '/repo', '-s', 'read-only', '--ephemeral', '--json', '--output-schema', '/repo/scripts/review-verdict.schema.json', 'review please',
  ]);
});

// parseVerdict unit tests
test('parseVerdict recognizes exact tokens', () => {
  assert.equal(parseVerdict('PASS'), 'PASS');
  assert.equal(parseVerdict('PASS WITH FIXES'), 'PASS_WITH_FIXES');
  assert.equal(parseVerdict('PASS_WITH_FIXES'), 'PASS_WITH_FIXES');
  assert.equal(parseVerdict('PASS-WITH-FIXES'), 'PASS_WITH_FIXES');
  assert.equal(parseVerdict('FAIL'), 'FAIL');
  assert.equal(parseVerdict('some text\nPASS\nmore'), 'PASS');
  assert.equal(parseVerdict('no verdict here'), null);
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict(undefined), null);
  assert.equal(parseVerdict(123), null);
});

test('parseVerdict fails closed on zero or multiple authoritative tokens', () => {
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict('looks good overall'), null);
  assert.equal(parseVerdict('FAIL\nPASS'), null);
  assert.equal(parseVerdict('PASS\nFAIL'), null);
  assert.equal(parseVerdict('PASS\nPASS WITH FIXES'), null);
  assert.equal(parseVerdict('PASS_WITH_FIXES\nFAIL'), null);
  assert.equal(parseVerdict('PASS\nPASS'), null);
  assert.equal(parseVerdict('FAIL\nsome notes\nPASS WITH FIXES'), null);
  // Must never infer PASS from ambiguous contradictory output.
  assert.notEqual(parseVerdict('FAIL\nPASS'), 'PASS');
  assert.notEqual(parseVerdict('PASS\nFAIL'), 'PASS');
});

test('structured review protocol parses PASS, PASS_WITH_FIXES, and FAIL', () => {
  assert.deepEqual(parseReviewResult(review('PASS')), { ok: true, verdict: 'PASS', blockers: [] });
  assert.deepEqual(parseReviewResult(review('PASS_WITH_FIXES', ['one'])), { ok: true, verdict: 'PASS_WITH_FIXES', blockers: ['one'] });
  assert.deepEqual(parseReviewResult(review('FAIL', ['blocked'])), { ok: true, verdict: 'FAIL', blockers: ['blocked'] });
  assert.equal(parseReviewResult(review('FAIL', ['Review not yet completed.'])).code, 'REVIEW_PROTOCOL_ERROR');
});

test('malformed review is REVIEW_PROTOCOL_ERROR and resumes without Cursor/build replay', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    let cursorCalls = 0;
    let testCalls = 0;
    const first = await run(root, {
      cursorInvoker: () => { cursorCalls++; },
      codexInvoker: () => 'PASS',
      testRunner: () => { testCalls++; return passingTests()(); },
    });
    assert.equal(first.status, 'REVIEW_PROTOCOL_ERROR');
    assert.equal(first.last_verdict, 'REVIEW_PROTOCOL_ERROR');
    assert.equal(first.codex_verdicts.length, 0);
    assert.equal(cursorCalls, 1);
    assert.equal(testCalls, 1);

    const resumed = await run(root, {
      cursorInvoker: () => { throw new Error('Cursor must not rerun'); },
      codexInvoker: () => review('PASS'),
      testRunner: () => { throw new Error('tests must not rerun'); },
    });
    assert.equal(resumed.status, 'READY_FOR_NEXT_V1_0_SLICE');
    assert.equal(resumed.last_verdict, 'PASS');
    assert.equal(resumed.cursor_runs, 1);
    assert.deepEqual(resumed.codex_verdicts, ['PASS']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('successful review reconciliation clears stale failed acceptance state, then next invocation advances', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    let cursorCalls = 0;
    let testCalls = 0;
    const first = await run(root, {
      cursorInvoker: () => { cursorCalls++; },
      codexInvoker: () => 'malformed conversational response',
      testRunner: () => { testCalls++; return passingTests()(); },
    });
    assert.equal(first.status, 'REVIEW_PROTOCOL_ERROR');
    assert.equal(cursorCalls, 1);
    assert.equal(testCalls, 1);

    // Legacy durable shape from before malformed review was split from
    // substantive acceptance failure: it must be reconcilable without replay.
    const staleBlockers = ['stale malformed review failure'];
    saveState(root, {
      ...loadState(root),
      status: 'FAILED_ACCEPTANCE_GATE',
      last_verdict: 'MALFORMED_VERDICT',
      codex_verdicts: ['MALFORMED_VERDICT'],
      blockers: staleBlockers,
      cursor_runs: 1,
    });

    const resumed = await run(root, {
      cursorInvoker: () => { throw new Error('Cursor must not rerun after completed build/test state'); },
      codexInvoker: () => review('PASS'),
      testRunner: () => { throw new Error('tests must not rerun after completed build/test state'); },
    });
    assert.equal(resumed.status, 'READY_FOR_NEXT_V1_0_SLICE');
    assert.equal(resumed.last_verdict, 'PASS');
    assert.deepEqual(resumed.codex_verdicts, ['PASS']);
    assert.deepEqual(resumed.blockers, []);

    const durable = loadState(root);
    assert.equal(durable.status, 'READY_FOR_NEXT_V1_0_SLICE');
    assert.equal(durable.last_verdict, 'PASS');
    assert.deepEqual(durable.blockers, []);
    assert.notDeepEqual(durable.blockers, staleBlockers);

    const c2 = mockCursor();
    const advanced = await run(root, {
      cursorInvoker: c2.invoker,
      codexInvoker: () => review('PASS'),
      testRunner: passingTests(),
    });
    assert.equal(advanced.status, 'READY_FOR_NEXT_V1_0_SLICE');
    assert.equal(advanced.current_phase_id, 'F-03');
    assert.equal(c2.calls.length, 1, 'next explicit invocation advances exactly once');
    assert.match(c2.calls[0].prompt, /phase F-03/);
    assert.doesNotMatch(c2.calls[0].prompt, /phase F-02/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('completed phase remains safely stopped at READY in the accepting invocation', async () => {
  const root = makeFixture({ completedSlices: ['F-01'] });
  try {
    const c = mockCursor();
    const state = await run(root, {
      cursorInvoker: c.invoker,
      codexInvoker: () => review('PASS'),
      testRunner: passingTests(),
    });
    assert.equal(state.status, 'READY_FOR_NEXT_V1_0_SLICE');
    assert.equal(state.current_phase_id, 'F-02');
    assert.equal(c.calls.length, 1, 'accepting invocation must not recursively launch the following slice');
    const transitions = readFileSync(join(root, 'artifacts/build-runner/transitions.jsonl'), 'utf8');
    assert.match(transitions, /"phase":"F-02","state":"READY_FOR_NEXT_V1_0_SLICE"/);
    assert.doesNotMatch(transitions, /"phase":"F-03","state":"CONTRACTED"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F-12 READY advances to SOT-derived F-13 without replaying F-12', async () => {
  const root = makeFixture({ completedSlices: completedThrough('F-12') });
  try {
    const acceptedSha = git(root, ['rev-parse', 'HEAD']);
    saveState(root, {
      ...loadState(root),
      status: 'READY_FOR_NEXT_V1_0_SLICE',
      current_phase_id: 'F-12',
      last_accepted_sha: acceptedSha,
      last_verdict: 'PASS',
      codex_verdicts: ['PASS_WITH_FIXES', 'FAIL'],
      blockers: [],
    });

    const c = mockCursor();
    const state = await run(root, {
      cursorInvoker: c.invoker,
      codexInvoker: () => review('PASS'),
      testRunner: passingTests(),
    });
    assert.equal(state.status, 'READY_FOR_NEXT_V1_0_SLICE');
    assert.equal(state.current_phase_id, 'F-13');
    assert.equal(c.calls.length, 1);
    assert.match(c.calls[0].prompt, /phase F-13/);
    assert.doesNotMatch(c.calls[0].prompt, /phase F-12/);

    const contract = JSON.parse(readFileSync(join(root, 'artifacts/build-runner/current-phase.json'), 'utf8'));
    assert.equal(contract.phase_id, 'F-13');
    assert.match(contract.phase_name, /Backup \/ restore/i);

    const durable = loadState(root);
    assert.ok(durable.accepted_phase_history.some((entry) =>
      entry.phase_id === 'F-12' && entry.accepted_sha === acceptedSha && entry.verdict === 'PASS'
    ), 'F-12 accepted SHA/history must remain intact after F-13 starts');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('READY advancement cannot skip a required SOT slice', async () => {
  const root = makeFixture({ completedSlices: completedThrough('F-10') });
  try {
    const acceptedSha = git(root, ['rev-parse', 'HEAD']);
    saveState(root, {
      ...loadState(root),
      status: 'READY_FOR_NEXT_V1_0_SLICE',
      current_phase_id: 'F-10',
      last_accepted_sha: acceptedSha,
      last_verdict: 'PASS',
      blockers: [],
    });

    const state = await run(root, { dryRun: true });
    assert.equal(state.status, 'WAITING_ON_OWNER');
    assert.equal(state.current_phase_id, 'F-11');
    const contract = JSON.parse(readFileSync(join(root, 'artifacts/build-runner/current-phase.json'), 'utf8'));
    assert.equal(contract.phase_id, 'F-11');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate READY invocation cannot launch two next phases', async () => {
  const root = makeFixture({ completedSlices: completedThrough('F-12') });
  let release = null;
  try {
    saveState(root, {
      ...loadState(root),
      status: 'READY_FOR_NEXT_V1_0_SLICE',
      current_phase_id: 'F-12',
      last_accepted_sha: git(root, ['rev-parse', 'HEAD']),
      last_verdict: 'PASS',
      blockers: [],
    });
    release = acquireRunLock(root);
    let cursorCalls = 0;
    await assert.rejects(
      () => run(root, {
        cursorInvoker: () => { cursorCalls++; },
        codexInvoker: () => review('PASS'),
        testRunner: passingTests(),
      }),
      (e) => e instanceof BuildRunnerError && e.code === 'RUN_ALREADY_ACTIVE'
    );
    assert.equal(cursorCalls, 0, 'lock must prevent a duplicate next-phase launch before Cursor starts');
  } finally {
    if (release) release();
    rmSync(root, { recursive: true, force: true });
  }
});

test('READY transition preserves accepted SHA while carrying current clean controller HEAD', async () => {
  const root = makeFixture({ completedSlices: completedThrough('F-12') });
  try {
    const acceptedSha = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'scripts/controller-transition-fix.mjs'), '// controller-only transition fix\n');
    git(root, ['add', 'scripts/controller-transition-fix.mjs']);
    git(root, ['commit', '-q', '-m', 'controller transition fix']);
    const controllerSha = git(root, ['rev-parse', 'HEAD']);

    saveState(root, {
      ...loadState(root),
      status: 'READY_FOR_NEXT_V1_0_SLICE',
      current_phase_id: 'F-12',
      last_accepted_sha: acceptedSha,
      last_verdict: 'PASS',
      blockers: [],
    });

    const state = await run(root, { dryRun: true });
    assert.equal(state.status, 'WAITING_ON_OWNER');
    assert.equal(state.current_phase_id, 'F-13');
    assert.equal(state.last_accepted_sha, acceptedSha);
    assert.equal(state.base_sha, controllerSha);

    const contract = JSON.parse(readFileSync(join(root, 'artifacts/build-runner/current-phase.json'), 'utf8'));
    assert.equal(contract.phase_id, 'F-13');
    assert.equal(contract.base_sha, controllerSha);

    const durable = loadState(root);
    assert.ok(durable.accepted_phase_history.some((entry) =>
      entry.phase_id === 'F-12' && entry.accepted_sha === acceptedSha
    ));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// determineNextSlice: first incomplete slice from SOT, not a phase count
test('determineNextSlice returns first incomplete slice', () => {
  const root = makeFixture({ completedSlices: [] });
  try {
    const s = determineNextSlice(root);
    assert.equal(s.phase_id, 'F-02'); // F-01 marker created by fixture
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('determineNextSlice returns null when all markers present (V1_0_COMPLETE)', () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id) });
  try {
    assert.equal(determineNextSlice(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run reaches V1_0_COMPLETE when all slices already evidenced', async () => {
  const root = makeFixture({ completedSlices: FOUNDATION_SLICES.map((s) => s.phase_id) });
  try {
    const state = await run(root, { dryRun: true });
    assert.equal(state.status, 'V1_0_COMPLETE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
