// scripts/build-runner.mjs
// Local Build Runner for JARVIS / AGENCYOS.
//
// Smallest deterministic local runner that:
//   - verifies repo root, SOT (against the approved manifest hash), safe Git state;
//   - determines the next smallest valid V1.0 Foundation slice FROM SOT
//     (docs/master-sot/12_ACCEPTANCE_AND_IMPLEMENTATION.md "V1.0 FOUNDATION" list)
//     using completed evidence markers, NOT a hard-coded total phase count;
//   - materializes + validates artifacts/build-runner/current-phase.json;
//   - creates a phase branch from the last accepted state;
//   - invokes supported headless Cursor CLI (cursor-agent) via keychain-backed
//     CURSOR_API_KEY as sole writer; never prints/logs the key;
//   - runs independent deterministic tests BEFORE Codex;
//   - invokes native Codex read-only only after tests pass;
//   - parses PASS | PASS_WITH_FIXES | FAIL and fails closed on anything else;
//   - allows at most ONE bounded Cursor repair cycle and requires the second
//     Codex verdict to be PASS;
//   - refuses dirty or ambiguous Git state;
//   - never prints credentials;
//   - is resumable via artifacts/build-runner/state.json;
//   - stops only at WAITING_ON_OWNER | WAITING_ON_ARCHITECTURE |
//     FAILED_ACCEPTANCE_GATE | V1_0_COMPLETE.
//
// Cursor is the ONLY writer. Codex is REVIEW-ONLY. The runner never auto-merges
// and never modifies docs/master-sot. Business-write autonomy stays DISABLED
// for every V1.0 Foundation slice.
//
// Dry-run / mock execution lets the runner identify and contract the next slice
// without making application-phase changes.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const APPROVED_MANIFEST_SHA256 =
  '8454dc306866ced3a5b7f7a827131cbba3587a741b2c948c16e0b1bfde226a87';

export const REPO_ROOT_MARKERS = ['AGENTS.md', 'docs/master-sot/00_START_HERE.md', 'package.json'];

export const TERMINAL_STOP_STATES = Object.freeze([
  'WAITING_ON_OWNER',
  'WAITING_ON_ARCHITECTURE',
  'FAILED_ACCEPTANCE_GATE',
  'V1_0_COMPLETE',
]);

export const STATE_FILE = 'artifacts/build-runner/state.json';
export const PHASE_CONTRACT_FILE = 'artifacts/build-runner/current-phase.json';
export const LOCK_DIR = 'artifacts/build-runner/.run.lock';
export const TRANSITION_LOG = 'artifacts/build-runner/transitions.jsonl';
export const REVIEW_SCHEMA_FILE = 'scripts/review-verdict.schema.json';

// Native local-authenticated CLIs. Secrets are deliberately not read by the
// runner and therefore cannot enter argv, environment, prompts, or logs.
export const CURSOR_AGENT_BIN = 'agent';
export const CODEX_BIN = 'codex';

// V1.0 Foundation slice registry, derived from
// docs/master-sot/12_ACCEPTANCE_AND_IMPLEMENTATION.md "V1.0 FOUNDATION" build
// list. Each entry is the smallest valid slice. Completion is determined by
// evidence markers (paths relative to repo root), NOT a hard-coded phase count.
// business_write_autonomy is DISABLED for every V1.0 slice per SOT.
export const FOUNDATION_SLICES = Object.freeze([
  {
    phase_id: 'F-01',
    phase_name: 'Private Git repo + SOT sync guard',
    scope: 'new private Git repo with protected main; SOT_SYNC_MANIFEST.sha256 guard that refuses on mismatch',
    non_scope: 'application code, migrations, business writes',
    sot_references: ['12_ACCEPTANCE_AND_IMPLEMENTATION.md#V1.0-FOUNDATION', '14_CODING_AGENT_BOOTSTRAP_AND_RUNBOOK.md'],
    acceptance_tests: ['#49 coding agent refuses to proceed if repo SOT hash mismatches approved manifest', '#48 build report records approved SOT manifest hash'],
    stop_conditions: ['SOT manifest mismatch', 'repo not private'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'scripts/verify-sot.mjs',
  },
  {
    phase_id: 'F-02',
    phase_name: 'Owner authentication / MFA skeleton',
    scope: 'authenticated owner session, MFA enrollment, step-up MFA for high-risk, session revocation',
    non_scope: 'live OAuth provider wiring, business writes',
    sot_references: ['01_ARCHITECTURE_LOCKS.md#Owner-authentication', '07_AUTHORITY_SECURITY_EXECUTION.md#Owner-root-of-trust'],
    acceptance_tests: ['#9 owner session requires authentication', '#10 high-risk approval requires recent step-up MFA', '#13 raw text owner approved has zero authorization value'],
    stop_conditions: ['missing MFA enrollment', 'WAITING_ON_OWNER for OAuth/MFA access'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'migrations/0003_owner_auth.sql',
  },
  {
    phase_id: 'F-03',
    phase_name: 'Tenants / users / memberships + RLS model',
    scope: 'tenant/users/memberships tables, RLS + FORCE RLS, transaction-local tenant context, non-superuser runtime role',
    non_scope: 'application-layer-only filtering as sole boundary',
    sot_references: ['01_ARCHITECTURE_LOCKS.md#Hard-tenant-isolation', '07_AUTHORITY_SECURITY_EXECUTION.md#Tenant-isolation'],
    acceptance_tests: ['#1-#8 tenant isolation', '#4 runtime DB role cannot bypass RLS', '#5 pooled connection A->B cannot leak tenant context'],
    stop_conditions: ['RLS bypass', 'BYPASSRLS granted'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'tests/rls-negative.test.mjs',
  },
  {
    phase_id: 'F-04',
    phase_name: 'Postgres state / evidence / receipts base',
    scope: 'events, current_state, evidence, receipts, PII subject_ref, contract_metadata tables',
    non_scope: 'reconciliation, business writes',
    sot_references: ['06_SYSTEM_CONTRACTS.md#CanonicalEvent', '06_SYSTEM_CONTRACTS.md#CurrentStateRecord', '06_SYSTEM_CONTRACTS.md#ExecutionReceipt'],
    acceptance_tests: ['#27 successful external effect has verified receipt', '#42 immutable receipts contain no raw deletable PII when opaque subject ref suffices'],
    stop_conditions: ['raw PII in receipts', 'missing contract version metadata'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'migrations/0006_events_state_evidence.sql',
  },
  {
    phase_id: 'F-05',
    phase_name: 'Authority / policy / kill epochs',
    scope: 'AuthorityGrant, ActionProposal, ApprovalDecision, PolicyDecision, kill/revocation epochs re-read before commit',
    non_scope: 'live external commit, business writes',
    sot_references: ['06_SYSTEM_CONTRACTS.md#AuthorityGrant', '06_SYSTEM_CONTRACTS.md#ApprovalDecision', '07_AUTHORITY_SECURITY_EXECUTION.md#Kill-revocation-TOCTOU'],
    acceptance_tests: ['#11 APPROVE works only for exact proposal_id + request_hash', '#12 payload/state mutation invalidates prior approval', '#14 revoked/expired grant blocks next action', '#32 revocation arriving between policy decision and commit blocks commit', '#34 authority/kill-store outage blocks material writes'],
    stop_conditions: ['stale epoch commits', 'fail-open on kill-store outage'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'tests/authority-kill.test.mjs',
  },
  {
    phase_id: 'F-06',
    phase_name: 'Canonical events + inbound authenticity',
    scope: 'webhook authenticity verification, dedupe, FAILED/UNKNOWN cannot materialize canonical state',
    non_scope: 'live provider webhooks, business writes',
    sot_references: ['06_SYSTEM_CONTRACTS.md#CanonicalEvent', '07_AUTHORITY_SECURITY_EXECUTION.md#Inbound-authenticity'],
    acceptance_tests: ['#15 forged/invalid-signature webhook cannot materialize canonical state', '#16 replay/duplicate creates one canonical event/state transition', '#17 authenticated payload text still remains untrusted for instruction purposes'],
    stop_conditions: ['unauthenticated event materializes canonical state'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'src/contracts/events.js',
  },
  {
    phase_id: 'F-07',
    phase_name: 'Capability registry',
    scope: 'Capability v1 contract, tenant-bound resolver, ambiguity classification (no autonomous retry when idempotency unsupported AND postcondition unobservable)',
    non_scope: 'live providers, connector registry persistence, business writes',
    sot_references: ['06_SYSTEM_CONTRACTS.md#Capability', '07_AUTHORITY_SECURITY_EXECUTION.md#Idempotency'],
    acceptance_tests: ['#25 provider with no idempotency and no observable postcondition cannot auto-retry after ambiguity', '#26 ambiguous API/MCP write cannot fall back to browser/Orgo until negative postcondition is verified'],
    stop_conditions: ['unsafe ambiguity classified as autonomously retryable'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'tests/capability-registry.test.mjs',
  },
  {
    phase_id: 'F-08',
    phase_name: 'Trusted executor (deterministic idempotency + postcondition verify)',
    scope: 'trusted executor flow: proposal -> validate tenant/context -> resolve capability -> load grant/policy -> revalidate revocation+kill epochs immediately before commit -> commit -> verify postcondition -> append receipt',
    non_scope: 'live external side effects, business writes enabled',
    sot_references: ['07_AUTHORITY_SECURITY_EXECUTION.md#Trusted-executor-flow', '06_SYSTEM_CONTRACTS.md#Deterministic-idempotency-key'],
    acceptance_tests: ['#21 deterministic idempotency key is stable across restart', '#22 duplicate same logical effect executes at most once', '#23 crash after external commit but before local completion does not duplicate effect', '#28 unknown effect remains AMBIGUOUS/UNKNOWN never silently SUCCEEDED'],
    stop_conditions: ['no verified receipt claimed success', 'fail-open on authority/kill outage'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'src/runtime/trusted-executor.js',
  },
  {
    phase_id: 'F-09',
    phase_name: 'DBOS durable workflows',
    scope: 'DBOS Transact + Postgres durable workflow steps; every nondeterministic LLM/tool/external interaction becomes a durable step; completed step survives restart without duplicate execution',
    non_scope: 'Temporal/Restate, business writes',
    sot_references: ['08_RUNTIME_WORKFLOWS_SPECIALISTS.md#DURABLE-WORKFLOWS'],
    acceptance_tests: ['#50 DBOS completed step survives restart without duplicate execution', '#51 approval wait survives restart', '#52 restore sequence freezes writers until Postgres/DBOS/providers reconcile'],
    stop_conditions: ['duplicate execution after restart', 'writers reactivated before reconciliation'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'src/runtime/dbos.js',
  },
  {
    phase_id: 'F-10',
    phase_name: 'Materialized state / freshness / reconciliation',
    scope: 'freshness FRESH|AGING|STALE|OFFLINE|CONFLICTED|UNKNOWN, conflict status, pending/ambiguous local effect never auto-overwritten as drift',
    non_scope: 'business writes',
    sot_references: ['06_SYSTEM_CONTRACTS.md#CurrentStateRecord', '07_AUTHORITY_SECURITY_EXECUTION.md#Reconciliation-safety'],
    acceptance_tests: ['#36 provider mismatch with no local pending effect safely repairs or escalates', '#37 pending/ambiguous local effect is never auto-overwritten as drift', '#38 stale source becomes STALE/UNKNOWN', '#39 conflicting authoritative evidence becomes CONFLICTED'],
    stop_conditions: ['ambiguous local effect overwritten as drift'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'src/runtime/reconciliation.js',
  },
  {
    phase_id: 'F-11',
    phase_name: 'Connector registry + read-only connector adapters',
    scope: 'Connector machine contract, credential broker ref (opaque), read-only adapters only',
    non_scope: 'writer connectors, business writes, raw secrets in prompts/logs',
    sot_references: ['06_SYSTEM_CONTRACTS.md#Capability', '07_AUTHORITY_SECURITY_EXECUTION.md#Credential-architecture'],
    acceptance_tests: ['#44 third-party tenant data never becomes global raw durable memory'],
    stop_conditions: ['raw secret in worker message', 'writer connector enabled'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'src/contracts/connector.js',
  },
  {
    phase_id: 'F-12',
    phase_name: 'Observability',
    scope: 'receipts/trace linkage, attention items, non-silenceable classes, deterministic materiality',
    non_scope: 'business writes',
    sot_references: ['10_OBSERVABILITY_RECOVERY.md', '01_ARCHITECTURE_LOCKS.md#Non-silenceable-classes'],
    acceptance_tests: ['#18 security/credential/authority/material financial/privacy/fault classes cannot be SILENCED', '#19 10,000 healthy/no-op events produce zero unnecessary strong-model wakes', '#20 same unresolved state hash does not repeatedly notify'],
    stop_conditions: ['non-silenceable class silenced'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'src/runtime/observability.js',
  },
  {
    phase_id: 'F-13',
    phase_name: 'Backup / restore rehearsal',
    scope: 'backup restore actually rehearsed',
    non_scope: 'business writes',
    sot_references: ['10_OBSERVABILITY_RECOVERY.md', '12_ACCEPTANCE_AND_IMPLEMENTATION.md#Recovery'],
    acceptance_tests: ['#53 backup restore is actually rehearsed'],
    stop_conditions: ['unrehearsed restore'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'tests/backup-restore.test.mjs',
  },
  {
    phase_id: 'F-14',
    phase_name: 'Security / privacy acceptance suite',
    scope: 'consolidated security/privacy acceptance tests covering deletion, PII erasure, third-party isolation',
    non_scope: 'business writes enabled',
    sot_references: ['12_ACCEPTANCE_AND_IMPLEMENTATION.md#Privacy-deletion', '07_AUTHORITY_SECURITY_EXECUTION.md#PII-erasure'],
    acceptance_tests: ['#40 valid customer deletion removes identifiable canonical data', '#41 embeddings/FTS/cache/derived summaries no longer expose deleted PII', '#43 non-identifying audit tombstone remains'],
    stop_conditions: ['deletion leaves PII in vectors/FTS/cache', 'no audit tombstone'],
    business_write_autonomy: 'DISABLED',
    evidence_marker: 'tests/security-privacy-acceptance.test.mjs',
  },
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BuildRunnerError extends Error {
  constructor(message, { code, state } = {}) {
    super(message);
    this.name = 'BuildRunnerError';
    this.code = code || 'BUILD_RUNNER_ERROR';
    this.state = state || null;
  }
}

// ---------------------------------------------------------------------------
// Repo root verification
// ---------------------------------------------------------------------------

export function verifyRepoRoot(root) {
  if (!root || typeof root !== 'string' || !existsSync(root)) {
    throw new BuildRunnerError('repo root does not exist: ' + root, { code: 'BAD_REPO_ROOT' });
  }
  for (const marker of REPO_ROOT_MARKERS) {
    if (!existsSync(join(root, marker))) {
      throw new BuildRunnerError(
        'repo root marker missing: ' + marker + ' (not a jarvis-agencyos root)',
        { code: 'BAD_REPO_ROOT' }
      );
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// SOT verification (refuses on mismatch; never modifies SOT)
// ---------------------------------------------------------------------------

export async function verifySot(root) {
  const sotDir = join(root, 'docs/master-sot');
  const manifestPath = join(sotDir, 'SOT_SYNC_MANIFEST.sha256');
  if (!existsSync(manifestPath)) {
    throw new BuildRunnerError('SOT manifest missing', { code: 'SOT_MISSING' });
  }
  // Use the repo's own verifier so behaviour stays identical to verify-sot.mjs.
  const bindingUrl = new URL('../src/contracts/sot-binding.js', import.meta.url);
  const { verifySotManifest } = await import(bindingUrl.pathname);
  const v = await verifySotManifest(sotDir);
  if (!v.ok) {
    throw new BuildRunnerError(
      'SOT manifest mismatch: refusing to proceed (SOT not modified)',
      { code: 'SOT_MISMATCH', state: { manifestHash: v.manifestHash, results: v.results } }
    );
  }
  if (v.manifestHash !== APPROVED_MANIFEST_SHA256) {
    throw new BuildRunnerError(
      'SOT manifest hash is not the approved manifest: ' +
        v.manifestHash + ' != ' + APPROVED_MANIFEST_SHA256,
      { code: 'SOT_MANIFEST_NOT_APPROVED', state: { manifestHash: v.manifestHash } }
    );
  }
  return { ok: true, manifestHash: v.manifestHash };
}

// ---------------------------------------------------------------------------
// Git state verification (refuses dirty / ambiguous; never auto-merges)
// ---------------------------------------------------------------------------

function gitSync(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    throw new BuildRunnerError(
      'git failed: ' + args.join(' ') + ' :: ' + ((e.stderr || e.stdout || e.message || '').split('\n')[0]),
      { code: 'GIT_ERROR' }
    );
  }
}

export function verifyGitState(root) {
  const branch = gitSync(root, ['branch', '--show-current']);
  if (!branch) {
    throw new BuildRunnerError('detached HEAD: refusing ambiguous state', { code: 'DIRTY_GIT' });
  }
  if (branch === 'main' || branch === 'master') {
    throw new BuildRunnerError(
      'refusing to run on protected branch ' + branch + ' (no auto-merge; create a phase branch)',
      { code: 'ON_PROTECTED_BRANCH' }
    );
  }
  const status = gitSync(root, ['status', '--porcelain']);
  if (status) {
    throw new BuildRunnerError(
      'refusing dirty working tree (commit or stash before running): ' + status.replace(/\n/g, ' | '),
      { code: 'DIRTY_GIT' }
    );
  }
  return { ok: true, branch, clean: !status };
}

export function currentHead(root) {
  return gitSync(root, ['rev-parse', 'HEAD']);
}

// ---------------------------------------------------------------------------
// Next-slice determination (from SOT + evidence markers, not phase count)
// ---------------------------------------------------------------------------

export function sliceIsComplete(root, slice) {
  return existsSync(join(root, slice.evidence_marker));
}

export function determineNextSlice(root) {
  for (const slice of FOUNDATION_SLICES) {
    if (!sliceIsComplete(root, slice)) return slice;
  }
  return null; // V1_0_COMPLETE
}

// ---------------------------------------------------------------------------
// Phase contract materialization + validation
// ---------------------------------------------------------------------------

export function buildPhaseContract(root, slice, baseSha) {
  return {
    phase_id: slice.phase_id,
    phase_name: slice.phase_name,
    base_sha: baseSha,
    scope: slice.scope,
    non_scope: slice.non_scope,
    sot_references: slice.sot_references,
    acceptance_tests: slice.acceptance_tests,
    stop_conditions: slice.stop_conditions,
    business_write_autonomy: slice.business_write_autonomy,
  };
}

export function validatePhaseContract(contract) {
  const required = [
    'phase_id', 'phase_name', 'base_sha', 'scope', 'non_scope',
    'sot_references', 'acceptance_tests', 'stop_conditions', 'business_write_autonomy',
  ];
  for (const k of required) {
    if (!(k in contract)) {
      throw new BuildRunnerError('current-phase.json missing field: ' + k, {
        code: 'MALFORMED_PHASE_CONTRACT',
      });
    }
  }
  if (contract.business_write_autonomy !== 'DISABLED') {
    throw new BuildRunnerError(
      'business_write_autonomy must be DISABLED for V1.0 Foundation (got ' +
        contract.business_write_autonomy + ')',
      { code: 'BUSINESS_WRITE_AUTONOMY_INVARIANT' }
    );
  }
  return true;
}

export function materializePhaseContract(root, contract) {
  validatePhaseContract(contract);
  const dir = join(root, 'artifacts/build-runner');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, PHASE_CONTRACT_FILE), JSON.stringify(contract, null, 2) + '\n');
  return join(root, PHASE_CONTRACT_FILE);
}

// ---------------------------------------------------------------------------
// Resumable state
// ---------------------------------------------------------------------------

export function defaultState() {
  return {
    status: 'INIT',
    last_accepted_sha: null,
    current_phase_id: null,
    phase_branch: null,
    cursor_runs: 0,
    codex_verdicts: [],
    last_verdict: null,
    // dry_run_checkpoint omitted on purpose: absent/undefined means "unknown /
    // legacy" so isDryRunOwnerCheckpoint can apply the contracted-only heuristic.
    // Explicit false is a genuine permanent owner gate.
    updated_at: null,
  };
}

// Dry-run stops at WAITING_ON_OWNER without invoking writer/reviewer. A later
// normal run must resume that checkpoint. Genuine owner gates set
// dry_run_checkpoint:false and remain fail-closed / permanent.
export function isDryRunOwnerCheckpoint(state) {
  if (!state || state.status !== 'WAITING_ON_OWNER') return false;
  if (state.dry_run_checkpoint === true) return true;
  if (state.dry_run_checkpoint === false) return false;
  // Legacy dry-run stops (pre-flag) look like contracted-only, never progressed.
  return (
    state.phase_branch == null &&
    (state.cursor_runs || 0) === 0 &&
    (!(state.codex_verdicts || []).length) &&
    state.last_verdict == null
  );
}

export function loadState(root) {
  const p = join(root, STATE_FILE);
  if (!existsSync(p)) return defaultState();
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    return { ...defaultState(), ...s };
  } catch (e) {
    throw new BuildRunnerError('state.json malformed: ' + e.message, {
      code: 'MALFORMED_STATE',
      state: { raw: readFileSync(p, 'utf8').slice(0, 200) },
    });
  }
}

export function saveState(root, state) {
  const dir = join(root, 'artifacts/build-runner');
  mkdirSync(dir, { recursive: true });
  const out = { ...state, updated_at: new Date().toISOString() };
  writeFileSync(join(root, STATE_FILE), JSON.stringify(out, null, 2) + '\n');
  appendFileSync(join(root, TRANSITION_LOG), JSON.stringify({
    timestamp: out.updated_at,
    phase: out.current_phase_id || null,
    state: out.status,
    command_type: 'controller_transition',
    exit_code: 0,
    artifact_paths: [STATE_FILE, PHASE_CONTRACT_FILE],
    test_summary: out.test_summary || null,
    review_verdict: out.last_verdict || null,
  }) + '\n');
  return out;
}

export function acquireRunLock(root) {
  const lock = join(root, LOCK_DIR);
  mkdirSync(join(root, 'artifacts/build-runner'), { recursive: true });
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
  } catch (e) {
    const ownerPath = join(lock, 'owner.json');
    let owner = null;
    try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')); } catch {}
    if (owner?.pid) {
      try { process.kill(owner.pid, 0); throw new BuildRunnerError('another run is active (pid ' + owner.pid + ')', { code: 'RUN_ALREADY_ACTIVE' }); }
      catch (probe) { if (probe instanceof BuildRunnerError) throw probe; }
    }
    try { unlinkSync(ownerPath); } catch {}
    try { rmdirSync(lock); } catch {}
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
  }
  return () => {
    try { unlinkSync(join(lock, 'owner.json')); } catch {}
    try { rmdirSync(lock); } catch {}
  };
}

// ---------------------------------------------------------------------------
// Verdict parsing (fail-closed on anything but PASS / PASS_WITH_FIXES / FAIL)
// ---------------------------------------------------------------------------

export const VERDICTS = Object.freeze(['PASS', 'PASS_WITH_FIXES', 'FAIL']);

export function parseVerdict(output) {
  if (typeof output !== 'string') return null;
  // Fail closed unless exactly one authoritative verdict token is present.
  // Codex review prompt asks for "PASS" | "PASS WITH FIXES" | "FAIL" on its
  // own. Accept those exact forms and a few safe spelling variants. Zero
  // tokens or multiple tokens (including contradictory FAIL then PASS /
  // PASS then FAIL) are ambiguous -> null (never infer PASS).
  const text = output.replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim());
  const found = [];
  for (const l of lines) {
    const up = l.toUpperCase();
    if (up === 'PASS') found.push('PASS');
    else if (up === 'PASS WITH FIXES' || up === 'PASS_WITH_FIXES' || up === 'PASS-WITH-FIXES')
      found.push('PASS_WITH_FIXES');
    else if (up === 'FAIL') found.push('FAIL');
  }
  if (found.length !== 1) return null;
  return found[0];
}

export const REVIEW_PROTOCOL_ERROR = 'REVIEW_PROTOCOL_ERROR';

// Codex emits JSONL events; only the final agent_message is authoritative.
// The message itself must be exactly the schema-shaped JSON object.
export function parseReviewResult(output) {
  if (typeof output !== 'string') return { ok: false, code: REVIEW_PROTOCOL_ERROR };
  const candidates = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event?.item?.type === 'agent_message' && typeof event.item.text === 'string') candidates.push(event.item.text);
      if (typeof event?.result === 'string') candidates.push(event.result);
      if (event && !event.type && !event.item && !event.result) candidates.push(line);
    } catch {}
  }
  candidates.push(output.trim());
  for (const candidate of candidates.reverse()) {
    let value;
    try { value = JSON.parse(candidate.trim()); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (Object.keys(value).sort().join(',') !== 'blockers,verdict') continue;
    if (!VERDICTS.includes(value.verdict) || !Array.isArray(value.blockers) || value.blockers.some((b) => typeof b !== 'string')) continue;
    if (value.blockers.some((b) => /review not yet completed/i.test(b))) continue;
    return { ok: true, verdict: value.verdict, blockers: value.blockers };
  }
  return { ok: false, code: REVIEW_PROTOCOL_ERROR };
}

// ---------------------------------------------------------------------------
// Phase branch creation (from last accepted state; never merges main)
// ---------------------------------------------------------------------------

export function createPhaseBranch(root, baseSha, slice) {
  const branchName = 'phase-build/' + slice.phase_id.toLowerCase();
  // Refuse if branch already exists with a different base (ambiguous state).
  let existing = null;
  try {
    existing = gitSync(root, ['rev-parse', branchName]);
  } catch (e) {
    existing = null;
  }
  if (existing) {
    if (existing !== baseSha) {
      throw new BuildRunnerError(
        'phase branch ' + branchName + ' already exists at ' + existing +
        ' != requested base ' + baseSha + ' (ambiguous state; refusing)',
        { code: 'AMBIGUOUS_BRANCH' }
      );
    }
    gitSync(root, ['checkout', branchName]);
    return branchName;
  }
  gitSync(root, ['branch', branchName, baseSha]);
  gitSync(root, ['checkout', branchName]);
  return branchName;
}

// ---------------------------------------------------------------------------
// Native invokers. Secrets are never placed in prompts, argv, environment, or logs.
// ---------------------------------------------------------------------------

function redactSecret(text, secret) {
  if (!secret) return String(text || '');
  return String(text || '').split(secret).join('[REDACTED]');
}

export function defaultCursorInvoker(root, prompt, deps = {}) {
  const bin = deps.agentBin || CURSOR_AGENT_BIN;
  const execFile = deps.execFileSync || execFileSync;
  try {
    return execFile(
      bin,
      ['--print', '--output-format', 'stream-json', '--workspace', root, '--trust', '--force', '--sandbox', 'disabled', prompt],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      }
    );
  } catch (e) {
    const raw = ((e && (e.stderr || e.stdout || e.message)) || '').toString();
    throw new BuildRunnerError(
      'agent failed: ' + raw.split('\n')[0],
      { code: 'CURSOR_INVOKE_FAILED' }
    );
  }
}

export function defaultCodexInvoker(root, prompt, deps = {}) {
  // Native Codex CLI form: read-only sandbox + ephemeral session + JSONL.
  const bin = deps.codexBin || CODEX_BIN;
  const execFile = deps.execFileSync || execFileSync;
  try {
    return execFile(
      bin,
      ['exec', '-C', root, '-s', 'read-only', '--ephemeral', '--json', '--output-schema', join(root, REVIEW_SCHEMA_FILE), prompt],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      }
    );
  } catch (e) {
    const raw = ((e && (e.stderr || e.stdout || e.message)) || '').toString();
    throw new BuildRunnerError(
      'codex failed: ' + raw.split('\n')[0],
      { code: 'CODEX_INVOKE_FAILED' }
    );
  }
}

// Default deterministic test runner: the repo's existing `npm test` suite.
export function defaultTestRunner(root) {
  try {
    const out = execFileSync('npm', ['test'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const pass = /# pass (\d+)/.exec(out);
    const fail = /# fail (\d+)/.exec(out);
    const passed = pass ? parseInt(pass[1], 10) : 0;
    const failed = fail ? parseInt(fail[1], 10) : 0;
    return { ok: failed === 0 && passed > 0, passed, failed, raw: out };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    return { ok: false, passed: 0, failed: 1, raw: out };
  }
}

// ---------------------------------------------------------------------------
// Writer prompt builder (no secrets; references SOT + contract only)
// ---------------------------------------------------------------------------

export function buildWriterPrompt(contract) {
  return [
    'You are the SOLE WRITER for JARVIS / AGENCYOS phase ' + contract.phase_id +
    ': ' + contract.phase_name + '.',
    'Read docs/master-sot/00_START_HERE.md first, then the files it marks required.',
    'Before any work: verify SOT_SYNC_MANIFEST.sha256 (must equal ' +
    APPROVED_MANIFEST_SHA256 + '). Stop on mismatch; never modify docs/master-sot.',
    'PHASE: ' + contract.phase_id + ' ' + contract.phase_name,
    'SCOPE: ' + contract.scope,
    'NON-SCOPE: ' + contract.non_scope,
    'SOT REFERENCES: ' + contract.sot_references.join(', '),
    'ACCEPTANCE TESTS: ' + contract.acceptance_tests.join(', '),
    'STOP CONDITIONS: ' + contract.stop_conditions.join(', '),
    'BUSINESS-WRITE AUTONOMY: ' + contract.business_write_autonomy +
    ' (must remain DISABLED).',
    'Rules: Cursor is the only writer. Do not merge main. Do not modify SOT.',
    'Do not enable business writes. Do not print credentials. Build the smallest',
    'valid slice, write focused tests, run npm test, commit on this branch.',
    'Return a short summary of files changed and test results.',
  ].join('\n');
}

export function buildReviewerPrompt(contract, baseSha) {
  return [
    'You are the independent REVIEW-ONLY Codex reviewer for JARVIS / AGENCYOS phase ' +
    contract.phase_id + ': ' + contract.phase_name + '.',
    'ROLE: Review only. Do not modify code as a concurrent writer.',
    'BASE SHA: ' + baseSha,
    'APPROVED SOT MANIFEST: ' + APPROVED_MANIFEST_SHA256,
    'Inspect: docs/master-sot/ (06/07/12), git diff, migrations, src, tests, evidence.',
    'Verify: business_write_autonomy stays DISABLED; no auto-merge; no SOT edits;',
    'acceptance tests for this phase are covered; no fail-open; no unsafe retry.',
    'Return ONLY this JSON object, with no Markdown, prose, or extra keys: {"verdict":"PASS|PASS_WITH_FIXES|FAIL","blockers":[]}.',
    'Use PASS_WITH_FIXES or FAIL only with concrete blocker strings; use an empty blockers array for PASS.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main runner loop
// ---------------------------------------------------------------------------

// Invariants enforced by run():
//   - max 2 Codex verdicts per phase (first + after one repair)
//   - PASS_WITH_FIXES allows at most ONE bounded Cursor repair cycle
//   - second Codex verdict MUST be PASS
//   - FAIL or malformed verdict -> FAILED_ACCEPTANCE_GATE (fail closed)
//   - never auto-merge; never modify SOT; never print credentials
//   - stops only at a TERMINAL_STOP_STATE
async function runUnlocked(root, opts = {}) {
  const {
    dryRun = false,
    preflighted = false,
    cursorInvoker = dryRun ? null : defaultCursorInvoker,
    codexInvoker = dryRun ? null : defaultCodexInvoker,
    testRunner = dryRun ? null : defaultTestRunner,
  } = opts;

  verifyRepoRoot(root);
  await verifySot(root);
  // Clean-Git preflight is identical for dry-run and normal mode: dirty trees
  // fail closed before phase determination, durable state/contract mutation,
  // Cursor/Codex invocation, branch creation, or application-phase work.
  if (!preflighted) verifyGitState(root);

  let state = loadState(root);

  // Recover the prior runner's malformed review without replaying Cursor or
  // deterministic tests. The durable transition log proves both completed.
  const priorReviewProtocolFailure = state.status === 'FAILED_ACCEPTANCE_GATE' &&
    state.last_verdict === 'MALFORMED_VERDICT' && state.cursor_runs > 0 &&
    existsSync(join(root, TRANSITION_LOG)) &&
    readFileSync(join(root, TRANSITION_LOG), 'utf8').includes('"state":"TESTS_PASSED"');
  if (priorReviewProtocolFailure) {
    state = saveState(root, { ...state, status: REVIEW_PROTOCOL_ERROR, last_verdict: REVIEW_PROTOCOL_ERROR, codex_verdicts: [] });
  }

  // Review-only resume path for a completed build/test phase.
  if (state.status === REVIEW_PROTOCOL_ERROR) {
    const contract = JSON.parse(readFileSync(join(root, PHASE_CONTRACT_FILE), 'utf8'));
    validatePhaseContract(contract);
    const review = reviewOnce(codexInvoker, root, contract, state.base_sha);
    if (!review.ok) return saveState(root, { ...state, status: REVIEW_PROTOCOL_ERROR, last_verdict: REVIEW_PROTOCOL_ERROR });
    if (review.verdict !== 'PASS') return saveState(root, { ...state, status: 'FAILED_ACCEPTANCE_GATE', last_verdict: review.verdict, codex_verdicts: [review.verdict] });
    return acceptPhase(root, { ...state, status: 'CODEX_VERDICT_1', codex_verdicts: ['PASS'], last_verdict: 'PASS' }, { phase_id: state.current_phase_id });
  }

  // If already at a terminal stop state, report and stop — except a dry-run
  // WAITING_ON_OWNER checkpoint, which a later normal run must resume.
  if (TERMINAL_STOP_STATES.includes(state.status)) {
    if (dryRun && state.status === 'WAITING_ON_OWNER' && isDryRunOwnerCheckpoint(state)) {
      // Repeated dry-run: refresh checkpoint marker and remain stopped.
      return saveState(root, {
        ...state,
        status: 'WAITING_ON_OWNER',
        dry_run_checkpoint: true,
      });
    }
    if (!(state.status === 'WAITING_ON_OWNER' && !dryRun && isDryRunOwnerCheckpoint(state))) {
      return state;
    }
    // Clear the dry-run checkpoint marker and continue the real flow.
    state = { ...state, dry_run_checkpoint: false };
  }

  // Determine last accepted state: persisted, else current HEAD.
  const baseSha = state.last_accepted_sha || currentHead(root);

  // Determine next slice from SOT + evidence markers (not a phase count).
  const slice = determineNextSlice(root);
  if (!slice) {
    state = saveState(root, { ...state, status: 'V1_0_COMPLETE', dry_run_checkpoint: false });
    return state;
  }

  // Materialize + validate the phase contract.
  const contract = buildPhaseContract(root, slice, baseSha);
  validatePhaseContract(contract);
  materializePhaseContract(root, contract);
  state = saveState(root, {
    ...state,
    status: 'CONTRACTED',
    current_phase_id: slice.phase_id,
    base_sha: baseSha,
    dry_run_checkpoint: false,
  });

  // Dry-run / mock: identify + contract the next slice only. Do NOT invoke a
  // real writer, do NOT mark acceptance, do NOT make application-phase changes.
  // Stop at WAITING_ON_OWNER (owner launch of a normal run is required). The
  // dry_run_checkpoint flag lets that later normal run resume; genuine owner
  // gates must set dry_run_checkpoint:false and stay permanent.
  if (dryRun) {
    state = saveState(root, {
      ...state,
      status: 'WAITING_ON_OWNER',
      dry_run_checkpoint: true,
    });
    return state;
  }

  // Create phase branch from last accepted state (never merges main).
  {
    const branch = createPhaseBranch(root, baseSha, slice);
    state = saveState(root, { ...state, status: 'BRANCH_CREATED', phase_branch: branch });
  }

  // ---- Cursor writer (sole writer) ----
  let writerOk = true;
  if (cursorInvoker) {
    try {
      cursorInvoker(root, buildWriterPrompt(contract));
    } catch (e) {
      writerOk = false;
      state = saveState(root, {
        ...state,
        status: 'FAILED_ACCEPTANCE_GATE',
        last_verdict: 'WRITER_ERROR',
      });
      return state;
    }
  }
  state = saveState(root, {
    ...state,
    status: 'WRITER_DONE',
    cursor_runs: state.cursor_runs + 1,
  });

  // ---- Independent deterministic tests ----
  let testsOk = true;
  if (testRunner) {
    const res = testRunner(root);
    if (!res.ok) {
      testsOk = false;
      state = saveState(root, {
        ...state,
        status: 'FAILED_ACCEPTANCE_GATE',
        last_verdict: 'TESTS_FAILED',
      });
      return state;
    }
  }
  state = saveState(root, { ...state, status: 'TESTS_PASSED' });

  // ---- Codex review (read-only; only after tests pass) ----
  // Max 2 verdicts. First verdict:
  const v1 = reviewOnce(codexInvoker, root, contract, baseSha);
  if (!v1.ok) return saveState(root, { ...state, status: REVIEW_PROTOCOL_ERROR, last_verdict: REVIEW_PROTOCOL_ERROR });
  state = saveState(root, {
    ...state,
    status: 'CODEX_VERDICT_1',
    codex_verdicts: [v1.verdict],
    last_verdict: v1.verdict,
  });

  if (v1.verdict === 'FAIL') {
    state = saveState(root, { ...state, status: 'FAILED_ACCEPTANCE_GATE', last_verdict: 'FAIL' });
    return state;
  }

  if (v1.verdict === 'PASS') {
    return acceptPhase(root, state, slice);
  }

  // v1 === 'PASS_WITH_FIXES' -> at most ONE bounded Cursor repair cycle.
  if (cursorInvoker) {
    try {
      cursorInvoker(root, buildWriterPrompt(contract) + '\n\nREPAIR CYCLE (Codex returned PASS_WITH_FIXES). Resolve the smallest concrete fixes only; do not expand scope.');
    } catch (e) {
      state = saveState(root, { ...state, status: 'FAILED_ACCEPTANCE_GATE', last_verdict: 'REPAIR_WRITER_ERROR' });
      return state;
    }
  }
  if (testRunner) {
    const res = testRunner(root);
    if (!res.ok) {
      state = saveState(root, { ...state, status: 'FAILED_ACCEPTANCE_GATE', last_verdict: 'REPAIR_TESTS_FAILED' });
      return state;
    }
  }
  state = saveState(root, { ...state, status: 'REPAIR_DONE', cursor_runs: state.cursor_runs + 1 });

  // Second Codex verdict MUST be PASS.
  const v2 = reviewOnce(codexInvoker, root, contract, baseSha);
  if (!v2.ok) return saveState(root, { ...state, status: REVIEW_PROTOCOL_ERROR, last_verdict: REVIEW_PROTOCOL_ERROR, codex_verdicts: [v1.verdict] });
  state = saveState(root, {
    ...state,
    status: 'CODEX_VERDICT_2',
    codex_verdicts: [v1.verdict, v2.verdict],
    last_verdict: v2.verdict,
  });

  if (v2.verdict !== 'PASS') {
    state = saveState(root, { ...state, status: 'FAILED_ACCEPTANCE_GATE', last_verdict: v2.verdict });
    return state;
  }

  return acceptPhase(root, state, slice);
}

export async function run(root, opts = {}) {
  verifyRepoRoot(root);
  await verifySot(root);
  verifyGitState(root);
  const release = acquireRunLock(root);
  try {
    return await runUnlocked(root, { ...opts, preflighted: true });
  } finally {
    release();
  }
}

function reviewOnce(codexInvoker, root, contract, baseSha) {
  if (!codexInvoker) return { ok: true, verdict: 'PASS', blockers: [] }; // dry-run with no reviewer
  let out;
  try {
    out = codexInvoker(root, buildReviewerPrompt(contract, baseSha));
  } catch (e) {
    return { ok: false, code: REVIEW_PROTOCOL_ERROR };
  }
  return parseReviewResult(out);
}

function acceptPhase(root, state, _slice) {
  // Acceptance records the HEAD after the Cursor writer finished. The runner
  // never writes application evidence markers itself (Cursor is sole writer).
  const next = {
    ...state,
    status: 'ACCEPTED',
    last_accepted_sha: currentHead(root),
  };
  return saveState(root, next);
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

export async function main(argv) {
  const args = (argv || process.argv.slice(2)).filter((a) => a);
  const dryRun = args.includes('--dry-run') || args.includes('--mock');
  const root = process.cwd();
  try {
    const state = await run(root, { dryRun });
    console.log('BUILD_RUNNER status=' + state.status);
    if (state.current_phase_id) console.log('  phase=' + state.current_phase_id);
    if (state.last_accepted_sha) console.log('  last_accepted_sha=' + state.last_accepted_sha);
    if (state.codex_verdicts && state.codex_verdicts.length)
      console.log('  codex_verdicts=' + state.codex_verdicts.join(','));
    if (state.last_verdict) console.log('  last_verdict=' + state.last_verdict);
    if (TERMINAL_STOP_STATES.includes(state.status)) process.exitCode = 0;
    else process.exitCode = 1; // non-terminal -> needs another run (resume)
  } catch (e) {
    if (e instanceof BuildRunnerError) {
      console.error('BUILD_RUNNER REFUSED code=' + e.code);
      console.error('  ' + e.message);
      process.exitCode = 1;
    } else {
      console.error('BUILD_RUNNER ERROR', e);
      process.exitCode = 1;
    }
  }
}

import { fileURLToPath } from 'node:url';
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main();
}
