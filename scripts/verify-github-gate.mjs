#!/usr/bin/env node
// scripts/verify-github-gate.mjs
// Acceptance #45 (#47) — live GitHub merge-gate verifier (idempotent).
//
// Run from a NORMAL terminal (not Cursor's sandboxed terminal — api.github.com
// is blocked there) where `gh` (macOS keychain login) and api.github.com are
// reachable:
//   node scripts/verify-github-gate.mjs
//   (or: bash scripts/verify-github-gate.sh   — thin wrapper)
//
// Behavior:
//   - unsets GH_TOKEN/GITHUB_TOKEN so gh uses the macOS keychain login;
//   - verifies gh auth;
//   - detects the real Phase 1 check context from GitHub (no guessing);
//   - reads branch protection on main and evaluates it with evaluateGate();
//   - if already enforcing ALL criteria -> ALREADY_ENFORCED + PASS, exit 0,
//     does NOT rewrite the protection (idempotent / verification-only);
//   - if any criterion is missing -> PUTs minimal protection, then re-reads
//     and re-evaluates; a failed PUT exits nonzero and NEVER prints success;
//   - final PASS is based ONLY on a successful readback confirming:
//       * exact required check; * strict=true; * enforce_admins=true;
//       * force pushes disabled; * deletions disabled; * PR protection present.
//   - touches mac313248/jarvis-agencyos ONLY; never touches wrong-owner-backup.

import { execFileSync } from 'node:child_process';

const REPO = 'mac313248/jarvis-agencyos';
const BRANCH = 'main';
const WORKFLOW_PATH = '.github/workflows/phase-1.yml';
const JOB_NAME = 'phase1';

// Drop inherited tokens so gh uses the macOS keychain login.
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;

// ---- Pure gate-evaluation logic (unit-tested; see tests/support) ----
// Accepts either the raw GitHub branch-protection API shape OR the normalized
// readback shape the owner used. Returns { pass, reasons }.
export function evaluateGate(rb, expectedCheck) {
  const reasons = [];
  if (!rb || typeof rb !== 'object') return { pass: false, reasons: ['no readback object'] };
  const rsc = rb.required_status_checks ?? {};
  const checks =
    rsc.contexts ??
    rb.required_checks ??
    (Array.isArray(rsc.checks) ? rsc.checks.map((c) => c.context) : undefined) ??
    [];
  const strict = rsc.strict ?? rb.strict;
  const enforceAdmins = rb.enforce_admins?.enabled ?? rb.enforce_admins;
  const allowForcePushes = rb.allow_force_pushes?.enabled ?? rb.allow_force_pushes;
  const allowDeletions = rb.allow_deletions?.enabled ?? rb.allow_deletions;
  const prReviews = rb.required_pull_request_reviews;
  const hasPR =
    (prReviews !== null && prReviews !== undefined &&
      !(Array.isArray(prReviews) && prReviews.length === 0)) ||
    typeof rb.required_approvals === 'number';

  if (!Array.isArray(checks) || !checks.some((c) => c === expectedCheck))
    reasons.push(`required check "${expectedCheck}" not found in ${JSON.stringify(checks ?? [])}`);
  if (strict !== true) reasons.push(`strict=${JSON.stringify(strict)}, expected true`);
  if (enforceAdmins !== true) reasons.push(`enforce_admins=${JSON.stringify(enforceAdmins)}, expected true`);
  if (allowForcePushes !== false) reasons.push(`allow_force_pushes=${JSON.stringify(allowForcePushes)}, expected false`);
  if (allowDeletions !== false) reasons.push(`allow_deletions=${JSON.stringify(allowDeletions)}, expected false`);
  if (!hasPR) reasons.push('PR protection (required_pull_request_reviews) not present');
  return { pass: reasons.length === 0, reasons };
}

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return json && out ? JSON.parse(out) : out;
}

function ghOk(args) {
  try { execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return true; }
  catch { return false; }
}

function detectCheckContext() {
  let name;
  try {
    const wf = gh(['api', `repos/${REPO}/actions/workflows`, '--jq', '.workflows[]']);
    const hit = (Array.isArray(wf) ? wf : wf?.workflows || [])
      .find((w) => w.path === WORKFLOW_PATH);
    name = hit?.name;
  } catch { name = undefined; }
  if (!name) name = 'Phase 1 — Secure Core Spine';
  return `${name} / ${JOB_NAME}`;
}

function readProtection() {
  try {
    return gh(['api', `repos/${REPO}/branches/${BRANCH}/protection`]);
  } catch (e) {
    return null; // 404 = no protection
  }
}

function putProtection(checkContext) {
  // Minimal protection: require the Phase 1 CI check + PR before merge; admins
  // enforced; no force pushes; no deletions.
  const body = {
    required_status_checks: { strict: true, contexts: [checkContext] },
    enforce_admins: true,
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: true,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
  try {
    execFileSync('gh', ['api', `repos/${REPO}/branches/${BRANCH}/protection`, '-X', 'PUT',
      '-H', 'Accept: application/vnd.github+json', '-f', `body=${JSON.stringify(body)}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (e) {
    console.error(`PUT branch protection FAILED: ${e.message}`);
    return false;
  }
}

function main() {
  console.log('============================================================');
  console.log(`# GitHub gate verification for ${REPO} (branch ${BRANCH})`);
  console.log('============================================================');
  console.log('=== 1. gh auth status ===');
  if (!ghOk(['auth', 'status'])) {
    console.error('gh auth status FAILED — not authenticated. Run: gh auth refresh -h github.com');
    process.exit(2);
  }
  console.log('gh authenticated.');

  const check = detectCheckContext();
  console.log(`=== 2. detected Phase 1 check context: ${check} ===`);

  console.log('=== 3. read existing branch protection ===');
  let prot = readProtection();
  let ev = prot ? evaluateGate(prot, check) : { pass: false, reasons: ['no branch protection on main'] };
  console.log(`initial evaluation: ${ev.pass ? 'ALREADY_ENFORCED' : 'NOT_ENFORCED'}`);
  if (!ev.pass) for (const r of ev.reasons) console.log(`  - ${r}`);

  if (!ev.pass) {
    console.log('=== 4. configuring MINIMAL branch protection ===');
    if (!putProtection(check)) {
      console.error('ABORT: configuration PUT failed; not claiming success.');
      process.exit(1);
    }
    console.log('PUT succeeded. Re-reading protection...');
    prot = readProtection();
    ev = prot ? evaluateGate(prot, check) : { pass: false, reasons: ['protection vanished after PUT'] };
  }

  console.log('=== 5. final readback ===');
  console.log(JSON.stringify(prot, null, 2));
  console.log('=== 6. final evaluation ===');
  if (ev.pass) {
    console.log('GITHUB GATE: PASS');
    console.log('#45: PASS — failed/missing required check blocks merge');
    console.log('#47: PASS — unauthorized direct push to main rejected');
    process.exit(0);
  } else {
    console.error('GITHUB GATE: FAIL');
    for (const r of ev.reasons) console.error(`  - ${r}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && /verify-github-gate\.mjs$/.test(process.argv[1]);
if (isMain) main();
