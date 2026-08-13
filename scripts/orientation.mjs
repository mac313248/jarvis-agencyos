// scripts/orientation.mjs
// Read-only Release Gate Orientation Evaluator.
//
// Reuses Master SOT release gates, build-runner F-slices, Builder Core claim
// paths, existing acceptance-test npm scripts, and the live-verification
// backlog. Does not create a second roadmap or task queue. Does not dispatch.
//
// Implementation-slice completion remains file-marker based
// (sliceIsComplete / determineNextSlice in build-runner.mjs).
// Release-gate completion is SHA-bound command evidence at HEAD.

import { randomUUID } from 'node:crypto';
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

/** @deprecated Global overwrite paths. Persist uses SHA/evaluation files instead. */
export const GATE_EVIDENCE_FILE = 'artifacts/orientation/gate-evidence.json';
export const ORIENTATION_BRIEF_FILE = 'artifacts/orientation/orientation.json';

export const EVIDENCE_CLASSIFICATION = Object.freeze({
  kind: 'ORIENTATION_EVALUATION',
  slice_markers: 'NOT_RELEASE_GATE_PROOF',
  command_results: 'SHA_BOUND_TEST_EVIDENCE',
  certifies_pass_done: false,
});

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

function parseCounts(raw) {
  const text = String(raw || '');
  const pass = /# pass (\d+)/.exec(text);
  const fail = /# fail (\d+)/.exec(text);
  return {
    passed: pass ? parseInt(pass[1], 10) : 0,
    failed: fail ? parseInt(fail[1], 10) : 0,
  };
}

export function defaultRunCommand(root, command) {
  const argv = Array.isArray(command.argv) ? command.argv : ['npm', 'run', command.name];
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const counts = parseCounts(out);
    return { ok: true, name: command.name, raw: out, exit_code: 0, ...counts };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const counts = parseCounts(out);
    const exitCode = Number.isInteger(e.status) ? e.status : 1;
    return { ok: false, name: command.name, raw: out, exit_code: exitCode, ...counts };
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

export async function evaluateReleaseGates(root, opts = {}) {
  const runCommand = opts.runCommand || defaultRunCommand;
  const selectedDurableWorkflow = Boolean(opts.selected_durable_workflow);
  const selectedT2Routine = opts.selected_t2_routine || null;
  const cache = new Map();

  async function runCached(command) {
    const key = command.name;
    if (cache.has(key)) return cache.get(key);
    const result = await Promise.resolve(runCommand(root, command));
    cache.set(key, result);
    return result;
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
        blockers: ['owner must select first bounded T2 routine'],
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
      const commandOk = Boolean(result?.ok);
      commands.push({
        name: command.name,
        ok: commandOk,
        exit_code: Number.isInteger(result?.exit_code) ? result.exit_code : (commandOk ? 0 : 1),
        passed: result?.passed || 0,
        failed: result?.failed || 0,
      });
      if (!commandOk) {
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

  return results;
}

function lastCompletedAuthorizedGate(gates) {
  let last = null;
  for (const gate of gates) {
    if (gate.test_result === 'PASS') last = gate;
  }
  return last;
}

function nextPhaseCandidate(gates) {
  for (const gate of gates) {
    if (gate.test_result === 'PASS' || gate.test_result === 'NOT_REQUIRED') continue;
    return gate;
  }
  return null;
}

function completedDeterministicGates(gates) {
  return gates.filter((g) => g.test_result === 'PASS').map((g) => g.gate_id);
}

function openLiveVerificationItems() {
  return LIVE_VERIFICATION_ITEMS.filter((item) => item.live_status === 'OPEN');
}

function liveVerificationBlockers() {
  return openLiveVerificationItems().map((item) => ({
    id: item.id,
    title: item.title,
    sot_ref: item.sot_ref,
    owner_gate: Boolean(item.owner_gate),
  }));
}

function ownerBlockers(gates) {
  const blockers = [];
  const v11 = gates.find((g) => g.gate_id === 'V1.1');
  if (v11?.test_result === 'WAITING_ON_OWNER') {
    blockers.push('owner must select the first bounded T2 routine');
  }
  for (const item of LIVE_VERIFICATION_ITEMS) {
    if (item.live_status === 'OPEN' && item.owner_gate) {
      blockers.push(item.title);
    }
  }
  return uniqueStrings(blockers);
}

function buildActiveWorkState({ nextSlice, gates, liveBlockers, owner }) {
  if (nextSlice) return 'IMPLEMENTATION_SLICE';
  if (gates.some((g) => g.test_result === 'FAIL')) return 'RELEASE_GATE_REPAIR';
  if (liveBlockers.length > 0) return 'LIVE_VERIFICATION_CLOSURE';
  if (owner.length > 0 || gates.some((g) => g.test_result === 'WAITING_ON_OWNER')) {
    return 'WAITING_ON_OWNER';
  }
  if (gates.some((g) => g.test_result === 'BLOCKED')) return 'RELEASE_GATE_REPAIR';
  return 'NO_ELIGIBLE_WORK';
}

function itemReady(item, gates) {
  return item.ready_after.every((req) => gates.find((g) => g.gate_id === req)?.test_result === 'PASS');
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

function buildClaimTask(root, headSha, nextSlice, current, gates) {
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
  if (current?.test_result === 'WAITING_ON_OWNER') {
    return {
      via: 'WAITING_ON_OWNER',
      command: null,
      dispatch: false,
      reason: current.blockers[0] || (current.gate_id + ' requires owner'),
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

function buildAdvance({ gates, candidate, liveBlockers, owner }) {
  const blockers = [];
  if (liveBlockers.length > 0) {
    blockers.push('live verification backlog remains');
    for (const item of liveBlockers) blockers.push(item.title);
  }
  if (owner.length > 0) {
    blockers.push(...owner);
  }
  if (candidate) {
    if (candidate.blockers?.length) blockers.push(...candidate.blockers);
    else blockers.push(candidate.gate_id + ' ' + candidate.test_result);
  }
  for (const gate of gates) {
    if (gate.test_result === 'FAIL') blockers.push(gate.gate_id + ' command evidence failed');
  }
  blockers.push('Codex review not performed by read-only orientation');
  blockers.push('orientation does not certify PASS/DONE');
  return {
    advance_allowed: false,
    advance_blockers: uniqueStrings(blockers),
  };
}

function collectCommandsExecuted(gates) {
  const out = [];
  const seen = new Set();
  for (const gate of gates) {
    for (const command of gate.commands || []) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      out.push({
        name: command.name,
        ok: Boolean(command.ok),
        exit_code: Number.isInteger(command.exit_code) ? command.exit_code : (command.ok ? 0 : 1),
        passed: command.passed || 0,
        failed: command.failed || 0,
      });
    }
  }
  return out;
}

function collectAcceptanceRefs(gates) {
  return uniqueStrings(gates.flatMap((g) => g.acceptance_tests || []));
}

export function persistOrientationEvidence(root, brief) {
  if (!brief?.head_sha || !brief?.evaluation_id) {
    throw new Error('persistOrientationEvidence requires head_sha and evaluation_id');
  }
  const relDir = join('artifacts/orientation', brief.head_sha);
  const relPath = join(relDir, brief.evaluation_id + '.json');
  const absPath = join(root, relPath);
  mkdirSync(join(root, relDir), { recursive: true });
  if (existsSync(absPath)) return relPath;
  const evidence = {
    evaluation_id: brief.evaluation_id,
    head_sha: brief.head_sha,
    evaluated_at: brief.evaluated_at,
    sot_manifest_sha256: brief.sot_manifest_sha256,
    approved_manifest_sha256: APPROVED_MANIFEST_SHA256,
    commands_executed: brief.commands_executed || collectCommandsExecuted(brief.release_gates || []),
    acceptance_test_references: brief.acceptance_test_references || collectAcceptanceRefs(brief.release_gates || []),
    live_verification_blockers: brief.live_verification_blockers || [],
    owner_blockers: brief.owner_blockers || [],
    advance_allowed: brief.advance_allowed,
    advance_blockers: brief.advance_blockers || [],
    evidence_classification: brief.evidence_classification || EVIDENCE_CLASSIFICATION,
    current_phase: brief.current_phase,
    next_phase_candidate: brief.next_phase_candidate,
    active_work_state: brief.active_work_state,
    completed_deterministic_gates: brief.completed_deterministic_gates,
    completed_implementation_slices: brief.completed_implementation_slices,
    release_gates: brief.release_gates || [],
    implementation_slices: brief.implementation_slices,
    business_write_autonomy: 'DISABLED',
  };
  writeFileSync(absPath, JSON.stringify(evidence, null, 2) + '\n');
  return relPath;
}

export async function buildOrientationBrief(root, opts = {}) {
  verifyRepoRoot(root);
  const sot = await verifySot(root);
  const headSha = opts.headSha || currentHead(root);
  const git = inspectGit(root);
  const gates = await evaluateReleaseGates(root, opts);
  const completed = FOUNDATION_SLICES.filter((slice) => sliceHasEvidenceMarker(root, slice)).map((s) => s.phase_id);
  const nextSlice = determineNextSlice(root, opts.acceptedPhaseIds || []);
  const authorized = lastCompletedAuthorizedGate(gates);
  const candidate = nextPhaseCandidate(gates);
  const currentPhase = authorized?.gate_id || null;
  const liveBlockers = liveVerificationBlockers();
  const owner = ownerBlockers(gates);
  const completedGates = completedDeterministicGates(gates);
  const activeWorkState = buildActiveWorkState({
    nextSlice,
    gates,
    liveBlockers,
    owner,
  });
  const readyWork = buildReadyWork(gates, nextSlice);
  const claimTask = buildClaimTask(root, headSha, nextSlice, candidate, gates);
  const { advance_allowed, advance_blockers } = buildAdvance({
    gates,
    candidate,
    liveBlockers,
    owner,
  });
  const evaluationId = opts.evaluation_id || ('eval_' + randomUUID());
  const commandsExecuted = collectCommandsExecuted(gates);
  const acceptanceRefs = collectAcceptanceRefs(gates);
  const brief = {
    evaluation_id: evaluationId,
    head_sha: headSha,
    git_branch: git.branch,
    git_dirty: git.dirty,
    sot_manifest_sha256: sot.manifestHash,
    evaluated_at: new Date().toISOString(),
    business_write_autonomy: 'DISABLED',
    dispatch: false,
    current_phase: currentPhase,
    next_phase_candidate: candidate?.gate_id || null,
    active_work_state: activeWorkState,
    completed_deterministic_gates: completedGates,
    completed_implementation_slices: completed,
    live_verification_blockers: liveBlockers,
    owner_blockers: owner,
    commands_executed: commandsExecuted,
    acceptance_test_references: acceptanceRefs,
    evidence_classification: EVIDENCE_CLASSIFICATION,
    release_gates: gates,
    implementation_slices: {
      completed,
      next: nextSlice ? { phase_id: nextSlice.phase_id, phase_name: nextSlice.phase_name } : null,
      status: nextSlice ? nextSlice.phase_id : 'V1_0_COMPLETE',
    },
    ready_work: readyWork,
    claim_task: claimTask,
    completion_proof: {
      commands: candidate
        ? (RELEASE_GATES.find((g) => g.gate_id === candidate.gate_id)?.verify_commands || []).map((c) => c.name)
        : [],
      acceptance_tests: candidate?.acceptance_tests || [],
      evidence_path: null,
      head_sha: headSha,
      note: 'Orientation reports test evidence only; it does not certify PASS/DONE',
    },
    unblocks_after: candidate?.unblocks || [],
    advance_allowed,
    advance_blockers,
  };
  const shouldPersist = Boolean(opts.persistEvidence || opts.writeEvidence);
  if (shouldPersist) {
    const evidencePath = persistOrientationEvidence(root, brief);
    brief.completion_proof.evidence_path = evidencePath;
    brief.evidence_path = evidencePath;
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
      ' advance_allowed=' + (brief.advance_allowed ? 'YES' : 'NO'),
    '  HEAD=' + brief.head_sha,
    '  current_phase=' + (brief.current_phase || 'none'),
    '  next_phase_candidate=' + (brief.next_phase_candidate || 'none'),
    '  completed_deterministic_gates=' + (brief.completed_deterministic_gates || []).join(','),
    '  sot_manifest_sha256=' + brief.sot_manifest_sha256,
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
