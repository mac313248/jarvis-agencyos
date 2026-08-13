// scripts/orientation.mjs
// Read-only Release Gate Orientation Evaluator.
//
// Reuses Master SOT release gates, build-runner F-slices, Builder Core claim
// paths, existing acceptance-test npm scripts, and the live-verification
// backlog. Does not create a second roadmap or task queue. Does not dispatch.
//
// Implementation-slice completion remains file-marker based
// (sliceHasEvidenceMarker / determineNextSlice in build-runner.mjs).
// Release-gate completion is SHA-bound command evidence at HEAD.
//
// Default invocation is truly read-only: JSON to stdout, no repo writes,
// no commits, no Cursor/Codex, no task claim. Persist only with
// --persist-evidence / npm run orientation:evidence.

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPROVED_MANIFEST_SHA256,
  FOUNDATION_SLICES,
  buildPhaseContract,
  currentHead,
  determineNextSlice,
  sliceHasEvidenceMarker,
  verifyRepoRoot,
  verifySot,
} from './build-runner.mjs';

/** Retired global overwrite path — persist uses SHA/evaluation-scoped files. */
export const GATE_EVIDENCE_FILE = 'artifacts/orientation/gate-evidence.json';
export const ORIENTATION_EVIDENCE_DIR = 'artifacts/orientation';

export const RELEASE_GATES = Object.freeze([
  {
    gate_id: 'BUILDER_STAGE_1',
    phase_name: 'Builder Stage 1',
    sot_references: [
      '12_ACCEPTANCE_AND_IMPLEMENTATION.md#BUILDER-STAGE-1',
      '14_CODING_AGENT_BOOTSTRAP_AND_RUNBOOK.md',
    ],
    requires: [],
    verify_commands: [
      { name: 'test:builder-stage1-deterministic', argv: ['npm', 'run', 'test:builder-stage1-deterministic'] },
    ],
    acceptance_tests: [
      '#48 Cursor builder cannot merge failed CI',
      '#49 Codex/reviewer cannot override valid deterministic test failure',
      '#50 Protected main rejects unauthorized direct push',
      '#51 build report records approved SOT manifest hash',
      '#52 coding agent refuses to proceed if repo SOT hash mismatches approved manifest',
      '#53 stale Builder run cannot overwrite current authoritative state',
      '#54 changed candidate invalidates prior verification/review/approval as applicable',
      '#55 raw secrets do not appear in logs/errors/provider state/trajectory evidence',
    ],
    unblocks: ['V1.0A'],
    owner_gate: false,
    conditional: false,
    business_write_autonomy: 'DISABLED',
  },
  {
    gate_id: 'V1.0A',
    phase_name: 'Read-Safe Foundation',
    sot_references: [
      '12_ACCEPTANCE_AND_IMPLEMENTATION.md#V1.0A',
      '01_ARCHITECTURE_LOCKS.md#Hard-tenant-isolation',
    ],
    requires: ['BUILDER_STAGE_1'],
    verify_commands: [
      { name: 'verify:sot', argv: ['npm', 'run', 'verify:sot'] },
      { name: 'test:v1.0a-postgres', argv: ['npm', 'run', 'test:v1.0a-postgres'] },
      { name: 'rls-negative', argv: ['node', '--test', 'tests/rls-negative.test.mjs'] },
      { name: 'inbound-authenticity', argv: ['node', '--test', 'tests/inbound-authenticity-gate.test.mjs'] },
      { name: 'reconciliation', argv: ['npm', 'run', 'test:f10'] },
      { name: 'privacy', argv: ['npm', 'run', 'test:f14'] },
      { name: 'capability-registry', argv: ['npm', 'run', 'test:phase2'] },
      { name: 'connector-registry', argv: ['npm', 'run', 'test:f11'] },
      { name: 'test:builder-stage1-deterministic', argv: ['npm', 'run', 'test:builder-stage1-deterministic'] },
    ],
    acceptance_tests: [
      '#1-#8 tenant isolation',
      '#15-#20 inbound authenticity',
      '#39-#42 read provenance/freshness',
      '#43-#47 privacy/confidentiality reads',
      '#48-#55 builder regression',
    ],
    unblocks: ['V1.0B', 'V1.0C parallel start'],
    owner_gate: false,
    conditional: false,
    business_write_autonomy: 'DISABLED',
  },
  {
    gate_id: 'V1.0B',
    phase_name: 'Agent 0 T0/T1 Early Value',
    sot_references: [
      '12_ACCEPTANCE_AND_IMPLEMENTATION.md#V1.0B',
      '05_PRODUCT_BEHAVIOR.md#Agent-0',
    ],
    requires: ['V1.0A'],
    verify_commands: [
      { name: 'test:v1.0b-agent0', argv: ['npm', 'run', 'test:v1.0b-agent0'] },
    ],
    acceptance_tests: [
      'Agent 0 T0 observe',
      'Agent 0 T1 recommend/draft',
      'Jarvis owner briefing over evidence-backed read state',
      'first-party portfolio synthesis under confidentiality rules',
    ],
    unblocks: ['Agent 0 T0/T1', 'Jarvis read briefings'],
    owner_gate: false,
    conditional: false,
    business_write_autonomy: 'DISABLED',
  },
  {
    gate_id: 'V1.0C',
    phase_name: 'Write-Safe Foundation',
    sot_references: [
      '12_ACCEPTANCE_AND_IMPLEMENTATION.md#V1.0C',
      '07_AUTHORITY_SECURITY_EXECUTION.md',
    ],
    requires: ['V1.0A'],
    verify_commands: [
      { name: 'test:v1.0c-write-safe', argv: ['npm', 'run', 'test:v1.0c-write-safe'] },
    ],
    acceptance_tests: [
      '#9-#14 owner/auth/approval',
      '#21-#38 write-path idempotency/kill/single-flight',
      '#39-#47 write-path reconciliation and deletion evidence',
    ],
    unblocks: ['V1.1 candidate selection'],
    owner_gate: false,
    conditional: false,
    business_write_autonomy: 'DISABLED',
  },
  {
    gate_id: 'V1.0D',
    phase_name: 'Durable Workflow (DBOS) only when justified',
    sot_references: [
      '12_ACCEPTANCE_AND_IMPLEMENTATION.md#V1.0D',
      '04_LIVE_VERIFICATION_BACKLOG.md#DBOS',
    ],
    requires: ['V1.0C'],
    verify_commands: [
      { name: 'test:f09', argv: ['npm', 'run', 'test:f09'] },
    ],
    acceptance_tests: [
      '#56 DBOS completed step survives restart without duplicate execution',
      '#57 approval wait survives restart',
    ],
    unblocks: [],
    owner_gate: false,
    conditional: true,
    business_write_autonomy: 'DISABLED',
  },
  {
    gate_id: 'V1.1',
    phase_name: 'First Bounded T2',
    sot_references: [
      '12_ACCEPTANCE_AND_IMPLEMENTATION.md#V1.1',
      '14_CODING_AGENT_BOOTSTRAP_AND_RUNBOOK.md#Phase-transition-rule',
    ],
    requires: ['V1.0C'],
    verify_commands: [],
    acceptance_tests: [
      'full write-path staging/shadow tests for the exact selected routine',
    ],
    unblocks: ['enable only the selected T2 routine'],
    owner_gate: true,
    conditional: false,
    business_write_autonomy: 'DISABLED',
  },
]);

export const LIVE_VERIFICATION_ITEMS = Object.freeze([
  {
    id: 'postgres-tenant-boundary',
    title: 'Postgres / tenant boundary live verification',
    live_status: 'OPEN',
    sot_ref: '04_LIVE_VERIFICATION_BACKLOG.md#Postgres--tenant-boundary',
    ready_after: ['V1.0A'],
    owner_gate: false,
    claim_via: 'EXECUTE_SOFTWARE_TASK',
  },
  {
    id: 'inbound-events',
    title: 'Inbound events live provider verification',
    live_status: 'OPEN',
    priority: 'HIGH',
    sot_ref: '04_LIVE_VERIFICATION_BACKLOG.md#Inbound-events',
    ready_after: ['V1.0A'],
    owner_gate: true,
    claim_via: 'WAITING_ON_OWNER',
  },
  {
    id: 'owner-authentication',
    title: 'Real MFA enrollment / step-up',
    live_status: 'OPEN',
    sot_ref: '04_LIVE_VERIFICATION_BACKLOG.md#Owner-authentication',
    ready_after: ['V1.0A'],
    owner_gate: true,
    claim_via: 'WAITING_ON_OWNER',
  },
  {
    id: 'authority-executor-effects',
    title: 'Authority / executor / effects live verification',
    live_status: 'OPEN',
    sot_ref: '04_LIVE_VERIFICATION_BACKLOG.md#Authority--executor--effects',
    ready_after: ['V1.0C'],
    owner_gate: false,
    claim_via: 'EXECUTE_SOFTWARE_TASK',
  },
  {
    id: 'dbos',
    title: 'DBOS durable workflow (adopt only when justified)',
    live_status: 'CONDITIONAL',
    sot_ref: '04_LIVE_VERIFICATION_BACKLOG.md#DBOS',
    ready_after: ['V1.0C'],
    owner_gate: false,
    claim_via: 'run-next-phase',
  },
  {
    id: 'github-live-candidate-smoke',
    title: 'Live GitHub candidate/PR/CI smoke (write access required)',
    live_status: 'OPEN',
    sot_ref: '04_LIVE_VERIFICATION_BACKLOG.md#Read-only-connectors',
    ready_after: ['BUILDER_STAGE_1'],
    owner_gate: true,
    claim_via: 'WAITING_ON_OWNER',
  },
  {
    id: 'read-only-connectors',
    title: 'Read-only connector adapters (GHL/Meta/Google/ClickUp/GitHub/payments)',
    live_status: 'OPEN',
    sot_ref: '04_LIVE_VERIFICATION_BACKLOG.md#Read-only-connectors',
    ready_after: ['V1.0A'],
    owner_gate: true,
    claim_via: 'WAITING_ON_OWNER',
  },
  {
    id: 'hermes-orgo',
    title: 'Hermes / Orgo boundaries',
    live_status: 'NOT_BLOCKER',
    sot_ref: '04_LIVE_VERIFICATION_BACKLOG.md#Hermes--Orgo',
    ready_after: ['V1.0A'],
    owner_gate: false,
    claim_via: 'EXECUTE_SOFTWARE_TASK',
  },
  {
    id: 'privacy-deletion',
    title: 'Privacy / deletion before outside customer data',
    live_status: 'OPEN',
    sot_ref: '04_LIVE_VERIFICATION_BACKLOG.md#Privacydeletion',
    ready_after: ['V1.0A'],
    owner_gate: false,
    claim_via: 'EXECUTE_SOFTWARE_TASK',
  },
  {
    id: 'owner-policy-thresholds',
    title: 'Owner policy thresholds (spend/refund/T2 envelopes)',
    live_status: 'OWNER_THRESHOLD',
    sot_ref: '04_LIVE_VERIFICATION_BACKLOG.md#Business-policy-still-requiring-owner-thresholds',
    ready_after: ['V1.0C'],
    owner_gate: true,
    claim_via: 'WAITING_ON_OWNER',
  },
]);

export const RELEASE_GATES_BY_ID = Object.freeze(
  Object.fromEntries(RELEASE_GATES.map((gate) => [gate.gate_id, gate]))
);

export const ACTIVE_WORK_STATES = Object.freeze({
  GATE_REPAIR: 'GATE_REPAIR',
  FOUNDATION_SLICE: 'FOUNDATION_SLICE',
  LIVE_VERIFICATION_CLOSURE: 'LIVE_VERIFICATION_CLOSURE',
  OWNER_T2_SELECTION: 'OWNER_T2_SELECTION',
  WAITING_ON_OWNER: 'WAITING_ON_OWNER',
  NO_ELIGIBLE_WORK: 'NO_ELIGIBLE_WORK',
});

export const EVIDENCE_CLASSIFICATION = Object.freeze({
  slice_markers: 'file existence only; not release-gate PASS',
  deterministic_gates: 'SHA-bound command evidence at HEAD',
  live_verification: 'SOT 04 backlog; not cleared by unit suites',
  owner_gates: 'require owner authority; orientation cannot satisfy',
  orientation: 'read-only briefing; does not certify PASS/DONE or phase advance',
});

function parseCounts(raw) {
  const text = String(raw || '');
  const pass = /# pass (\d+)/.exec(text);
  const fail = /# fail (\d+)/.exec(text);
  return {
    passed: pass ? parseInt(pass[1], 10) : 0,
    failed: fail ? parseInt(fail[1], 10) : 0,
  };
}

function commandArgv(command) {
  return Array.isArray(command.argv) ? [...command.argv] : ['npm', 'run', command.name];
}

export function newEvaluationId(headSha) {
  const sha = String(headSha || 'unknown').slice(0, 12);
  return `eval_${sha}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function defaultRunCommand(root, command) {
  const argv = commandArgv(command);
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const counts = parseCounts(out);
    return {
      ok: true,
      name: command.name,
      argv,
      exit_code: 0,
      raw: out,
      ...counts,
    };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const counts = parseCounts(out);
    return {
      ok: false,
      name: command.name,
      argv,
      exit_code: Number.isInteger(e.status) ? e.status : 1,
      raw: out,
      ...counts,
    };
  }
}

function inspectGit(root) {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { branch: branch || null, dirty: Boolean(porcelain) };
  } catch {
    return { branch: null, dirty: true };
  }
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function summarizeCommand(command, result) {
  return {
    name: command.name,
    argv: commandArgv(command),
    ok: Boolean(result?.ok),
    exit_code: result?.exit_code ?? (result?.ok ? 0 : 1),
    passed: result?.passed || 0,
    failed: result?.failed || 0,
  };
}

export async function evaluateReleaseGates(root, opts = {}) {
  const runCommand = opts.runCommand || defaultRunCommand;
  const selectedDurableWorkflow = Boolean(opts.selected_durable_workflow);
  const selectedT2Routine = opts.selected_t2_routine || null;
  const cache = new Map();
  const commandsExecuted = [];

  async function runCached(command) {
    const key = command.name;
    if (cache.has(key)) return cache.get(key);
    const result = await Promise.resolve(runCommand(root, command));
    const summarized = summarizeCommand(command, result);
    cache.set(key, { ...result, ...summarized });
    commandsExecuted.push(summarized);
    return cache.get(key);
  }

  const results = [];
  const byId = Object.create(null);

  for (const gate of RELEASE_GATES) {
    const blockers = [];
    if (gate.conditional && !selectedDurableWorkflow) {
      const row = {
        gate_id: gate.gate_id,
        phase_name: gate.phase_name,
        test_result: 'NOT_REQUIRED',
        owner_gate: false,
        blockers: [],
        commands: [],
        acceptance_tests: gate.acceptance_tests,
        sot_references: gate.sot_references,
        unblocks: gate.unblocks,
        business_write_autonomy: gate.business_write_autonomy,
      };
      results.push(row);
      byId[gate.gate_id] = row;
      continue;
    }

    for (const req of gate.requires) {
      if (byId[req]?.test_result !== 'PASS') {
        blockers.push('requires ' + req + ' PASS');
      }
    }

    if (blockers.length > 0) {
      const row = {
        gate_id: gate.gate_id,
        phase_name: gate.phase_name,
        test_result: 'BLOCKED',
        owner_gate: Boolean(gate.owner_gate),
        blockers,
        commands: [],
        acceptance_tests: gate.acceptance_tests,
        sot_references: gate.sot_references,
        unblocks: gate.unblocks,
        business_write_autonomy: gate.business_write_autonomy,
      };
      results.push(row);
      byId[gate.gate_id] = row;
      continue;
    }

    if (gate.owner_gate && !selectedT2Routine) {
      const row = {
        gate_id: gate.gate_id,
        phase_name: gate.phase_name,
        test_result: 'WAITING_ON_OWNER',
        owner_gate: true,
        blockers: ['owner must select the first bounded T2 routine'],
        commands: [],
        acceptance_tests: gate.acceptance_tests,
        sot_references: gate.sot_references,
        unblocks: gate.unblocks,
        business_write_autonomy: gate.business_write_autonomy,
      };
      results.push(row);
      byId[gate.gate_id] = row;
      continue;
    }

    const commands = [];
    let ok = true;
    for (const command of gate.verify_commands) {
      const result = await runCached(command);
      const summarized = summarizeCommand(command, result);
      commands.push(summarized);
      if (!summarized.ok) {
        ok = false;
        blockers.push(command.name + ' failed');
      }
    }

    const row = {
      gate_id: gate.gate_id,
      phase_name: gate.phase_name,
      test_result: ok ? 'PASS' : 'FAIL',
      owner_gate: Boolean(gate.owner_gate),
      blockers,
      commands,
      acceptance_tests: gate.acceptance_tests,
      sot_references: gate.sot_references,
      unblocks: gate.unblocks,
      business_write_autonomy: gate.business_write_autonomy,
    };
    results.push(row);
    byId[gate.gate_id] = row;
  }

  results.commands_executed = commandsExecuted;
  return results;
}

export function itemReady(item, gates) {
  return item.ready_after.every(
    (req) => gates.find((g) => g.gate_id === req)?.test_result === 'PASS'
  );
}

function completedDeterministicGates(gates) {
  return gates.filter((g) => g.test_result === 'PASS').map((g) => g.gate_id);
}

function nextPhaseCandidate(gates) {
  const pending = gates.find(
    (g) => g.test_result !== 'PASS' && g.test_result !== 'NOT_REQUIRED'
  );
  return pending?.gate_id || null;
}

function openLiveItems(gates) {
  return LIVE_VERIFICATION_ITEMS.filter(
    (item) => item.live_status === 'OPEN' && itemReady(item, gates)
  );
}

function deriveActiveWorkState({ nextSlice, gates, liveOpen, ownerBlockers }) {
  if (gates.some((g) => g.test_result === 'FAIL')) {
    return ACTIVE_WORK_STATES.GATE_REPAIR;
  }
  if (nextSlice) return ACTIVE_WORK_STATES.FOUNDATION_SLICE;
  if (liveOpen.length > 0) return ACTIVE_WORK_STATES.LIVE_VERIFICATION_CLOSURE;
  if (ownerBlockers.some((b) => /first bounded T2/i.test(b))) {
    return ACTIVE_WORK_STATES.OWNER_T2_SELECTION;
  }
  if (ownerBlockers.length > 0) return ACTIVE_WORK_STATES.WAITING_ON_OWNER;
  return ACTIVE_WORK_STATES.NO_ELIGIBLE_WORK;
}

function buildReadyWork(gates, nextSlice) {
  const ready = [];
  if (nextSlice) {
    ready.push({
      id: nextSlice.phase_id,
      type: 'implementation_slice',
      title: nextSlice.phase_name,
      source: 'scripts/build-runner.mjs#FOUNDATION_SLICES',
      claim_via: 'run-next-phase',
    });
  }
  for (const item of LIVE_VERIFICATION_ITEMS) {
    if (item.live_status === 'NOT_BLOCKER') continue;
    if (!itemReady(item, gates)) continue;
    ready.push({
      id: item.id,
      type: 'live_verification',
      title: item.title,
      source: item.sot_ref,
      live_status: item.live_status,
      claim_via: item.claim_via,
      owner_gate: Boolean(item.owner_gate),
    });
  }
  const v11 = gates.find((g) => g.gate_id === 'V1.1');
  if (v11?.test_result === 'WAITING_ON_OWNER') {
    ready.push({
      id: 'v1.1-select-t2',
      type: 'owner_gate',
      title: 'Select first bounded T2 routine',
      source: '12_ACCEPTANCE_AND_IMPLEMENTATION.md#V1.1',
      claim_via: 'WAITING_ON_OWNER',
      owner_gate: true,
    });
  }
  return ready;
}

function buildClaimTask(root, headSha, nextSlice, gates) {
  if (nextSlice) {
    return {
      via: 'run-next-phase',
      command: './scripts/run-next-phase',
      dispatch: false,
      reason: 'Next incomplete implementation slice from build-runner evidence markers',
      contract: buildPhaseContract(root, nextSlice, headSha),
    };
  }
  const live = LIVE_VERIFICATION_ITEMS.find((item) =>
    item.live_status === 'OPEN' &&
    item.claim_via === 'EXECUTE_SOFTWARE_TASK' &&
    !item.owner_gate &&
    itemReady(item, gates)
  );
  if (live) {
    return {
      via: 'EXECUTE_SOFTWARE_TASK',
      command: 'node scripts/jarvis-task.mjs',
      dispatch: false,
      reason: live.title,
      contract: {
        intent: live.title,
        acceptance_ref: live.sot_ref,
      },
    };
  }
  const v11 = gates.find((g) => g.gate_id === 'V1.1');
  if (v11?.test_result === 'WAITING_ON_OWNER') {
    return {
      via: 'WAITING_ON_OWNER',
      command: null,
      dispatch: false,
      reason: 'owner must select the first bounded T2 routine',
      contract: null,
    };
  }
  return {
    via: 'WAITING_ON_OWNER',
    command: null,
    dispatch: false,
    reason: 'No implementation slice remains; owner/live gate required',
    contract: null,
  };
}

export function buildAdvance({ gates, selectedT2Routine = null } = {}) {
  const blockers = [];
  const live_verification_blockers = [];
  const owner_blockers = [];

  for (const gate of gates || []) {
    if (gate.test_result === 'FAIL') {
      blockers.push(gate.gate_id + ' deterministic gate FAIL');
    }
  }

  for (const item of openLiveItems(gates || [])) {
    live_verification_blockers.push(item.id);
    blockers.push('live verification backlog remains: ' + item.id);
    if (item.owner_gate) {
      owner_blockers.push(item.title);
    }
  }

  if (!selectedT2Routine) {
    owner_blockers.push('owner must select the first bounded T2 routine');
    blockers.push('owner must select the first bounded T2 routine');
  }

  blockers.push('Codex review not performed by read-only orientation');
  blockers.push('orientation does not certify PASS/DONE');

  return {
    advance_allowed: false,
    advance_blockers: uniqueStrings(blockers),
    live_verification_blockers,
    owner_blockers: uniqueStrings(owner_blockers),
  };
}

export function orientationEvidencePath(headSha, evaluationId) {
  return join(ORIENTATION_EVIDENCE_DIR, headSha, evaluationId + '.json');
}

export function persistOrientationEvidence(root, brief) {
  if (!brief?.head_sha) {
    throw new Error('persistOrientationEvidence requires head_sha');
  }
  if (!brief?.evaluation_id) {
    throw new Error('persistOrientationEvidence requires evaluation_id');
  }
  const relative = orientationEvidencePath(brief.head_sha, brief.evaluation_id);
  const absolute = join(root, relative);
  if (existsSync(absolute)) {
    throw new Error('refusing to overwrite immutable orientation evidence: ' + relative);
  }
  mkdirSync(join(root, ORIENTATION_EVIDENCE_DIR, brief.head_sha), { recursive: true });
  const evidence = {
    evaluation_id: brief.evaluation_id,
    evaluated_at: brief.evaluated_at,
    head_sha: brief.head_sha,
    git_branch: brief.git_branch,
    sot_manifest_sha256: brief.sot_manifest_sha256,
    approved_manifest_sha256: APPROVED_MANIFEST_SHA256,
    commands_executed: brief.commands_executed || [],
    exit_codes: (brief.commands_executed || []).map((c) => ({
      name: c.name,
      exit_code: c.exit_code,
    })),
    acceptance_tests: brief.acceptance_tests || [],
    live_verification_blockers: brief.live_verification_blockers || [],
    owner_blockers: brief.owner_blockers || [],
    completed_implementation_slices: brief.completed_implementation_slices || [],
    completed_deterministic_gates: brief.completed_deterministic_gates || [],
    active_work_state: brief.active_work_state,
    next_phase_candidate: brief.next_phase_candidate,
    advance_allowed: brief.advance_allowed,
    advance_blockers: brief.advance_blockers,
    evidence_classification: brief.evidence_classification || EVIDENCE_CLASSIFICATION,
    business_write_autonomy: 'DISABLED',
    dispatch: false,
  };
  writeFileSync(absolute, JSON.stringify(evidence, null, 2) + '\n');
  return relative;
}

/** @deprecated Global overwrite path is retired. Use persistOrientationEvidence. */
export function writeGateEvidence(root, brief) {
  return persistOrientationEvidence(root, brief);
}

export async function buildOrientationBrief(root, opts = {}) {
  verifyRepoRoot(root);
  const sot = await verifySot(root);
  const headSha = opts.headSha || currentHead(root);
  const git = inspectGit(root);
  const gates = await evaluateReleaseGates(root, opts);
  const commandsExecuted = gates.commands_executed || [];
  const completedSlices = FOUNDATION_SLICES
    .filter((slice) => sliceHasEvidenceMarker(root, slice))
    .map((s) => s.phase_id);
  const nextSlice = determineNextSlice(root, opts.acceptedPhaseIds || []);
  const completedGates = completedDeterministicGates(gates);
  const candidate = nextPhaseCandidate(gates);
  const liveOpen = openLiveItems(gates);
  const advance = buildAdvance({
    gates,
    selectedT2Routine: opts.selected_t2_routine || null,
  });
  const activeWorkState = deriveActiveWorkState({
    nextSlice,
    gates,
    liveOpen,
    ownerBlockers: advance.owner_blockers,
  });
  const readyWork = buildReadyWork(gates, nextSlice);
  const claimTask = buildClaimTask(root, headSha, nextSlice, gates);
  const evaluationId = opts.evaluationId || newEvaluationId(headSha);
  const acceptanceTests = uniqueStrings(
    gates.flatMap((g) => g.acceptance_tests || [])
  );

  const brief = {
    evaluation_id: evaluationId,
    evaluated_at: new Date().toISOString(),
    head_sha: headSha,
    git_branch: git.branch,
    git_dirty: git.dirty,
    sot_manifest_sha256: sot.manifestHash,
    approved_manifest_sha256: APPROVED_MANIFEST_SHA256,
    business_write_autonomy: 'DISABLED',
    dispatch: false,
    persist_evidence: false,
    evidence_path: null,
    completed_implementation_slices: completedSlices,
    completed_deterministic_gates: completedGates,
    active_work_state: activeWorkState,
    next_phase_candidate: candidate,
    advance_allowed: advance.advance_allowed,
    advance_blockers: advance.advance_blockers,
    live_verification_blockers: advance.live_verification_blockers,
    owner_blockers: advance.owner_blockers,
    commands_executed: commandsExecuted,
    acceptance_tests: acceptanceTests,
    evidence_classification: EVIDENCE_CLASSIFICATION,
    release_gates: gates,
    implementation_slices: {
      completed: completedSlices,
      next: nextSlice ? { phase_id: nextSlice.phase_id, phase_name: nextSlice.phase_name } : null,
      status: nextSlice ? nextSlice.phase_id : 'V1_0_COMPLETE',
      marker_complete_is_not_release_gate_pass: true,
    },
    ready_work: readyWork,
    claim_task: claimTask,
    completion_proof: {
      commands: commandsExecuted.map((c) => c.name),
      acceptance_tests: acceptanceTests,
      head_sha: headSha,
      note: 'Orientation reports SHA-bound test evidence only; it does not certify PASS/DONE',
    },
    unblocks_after: RELEASE_GATES_BY_ID[candidate]?.unblocks || [],
  };

  const persist = Boolean(opts.persistEvidence || opts.writeEvidence);
  if (persist) {
    brief.persist_evidence = true;
    brief.evidence_path = persistOrientationEvidence(root, brief);
  }
  return brief;
}

export async function runOrientation(root, opts = {}) {
  return buildOrientationBrief(root, {
    ...opts,
    persistEvidence: Boolean(opts.persistEvidence || opts.writeEvidence),
  });
}

export function formatOrientationBrief(brief) {
  const lines = [
    'ORIENTATION active_work_state=' + brief.active_work_state +
      ' next_phase_candidate=' + (brief.next_phase_candidate || 'none') +
      ' advance_allowed=' + (brief.advance_allowed ? 'YES' : 'NO'),
    '  HEAD=' + brief.head_sha,
    '  sot_manifest_sha256=' + brief.sot_manifest_sha256,
    '  completed_deterministic_gates=' + (brief.completed_deterministic_gates || []).join(','),
    '  slices=' + brief.implementation_slices.status,
    '  claim_via=' + brief.claim_task.via + ' dispatch=false',
    '  business_write_autonomy=DISABLED',
  ];
  if (brief.advance_blockers?.length) {
    lines.push('  blockers:');
    for (const blocker of brief.advance_blockers) lines.push('  - ' + blocker);
  }
  return lines.join('\n');
}
