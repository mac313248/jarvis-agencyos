// tests/support/verifier-gate.test.mjs
// Unit test for the pure gate-evaluation logic in scripts/verify-github-gate.mjs.
// Deliberately outside the core `tests/*.test.mjs` glob (lives under
// tests/support/) so the core-spine suite stays at 41/41 and Phase 1 scope is
// not expanded. Run with:  node --test tests/support/verifier-gate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate } from '../../scripts/verify-github-gate.mjs';

const EXPECTED = 'Phase 1 — Secure Core Spine / phase1';

// The owner's actual normalized readback (live-verified) must PASS.
const ownerReadback = {
  allow_deletions: false,
  allow_force_pushes: false,
  enforce_admins: true,
  required_approvals: 0,
  required_checks: [EXPECTED],
  strict: true,
};

test('owner live readback -> PASS', () => {
  const r = evaluateGate(ownerReadback, EXPECTED);
  assert.equal(r.pass, true);
  assert.deepEqual(r.reasons, []);
});

test('raw GitHub API shape -> PASS', () => {
  const raw = {
    required_status_checks: { strict: true, contexts: [EXPECTED] },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
  const r = evaluateGate(raw, EXPECTED);
  assert.equal(r.pass, true);
});

test('missing required check -> FAIL', () => {
  const r = evaluateGate({ ...ownerReadback, required_checks: ['other'] }, EXPECTED);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(';'), /not found/);
});

test('strict=false -> FAIL', () => {
  const r = evaluateGate({ ...ownerReadback, strict: false }, EXPECTED);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(';'), /strict/);
});

test('enforce_admins=false -> FAIL', () => {
  const r = evaluateGate({ ...ownerReadback, enforce_admins: false }, EXPECTED);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(';'), /enforce_admins/);
});

test('allow_force_pushes=true -> FAIL', () => {
  const r = evaluateGate({ ...ownerReadback, allow_force_pushes: true }, EXPECTED);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(';'), /allow_force_pushes/);
});

test('allow_deletions=true -> FAIL', () => {
  const r = evaluateGate({ ...ownerReadback, allow_deletions: true }, EXPECTED);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(';'), /allow_deletions/);
});

test('no PR protection -> FAIL', () => {
  const raw = {
    required_status_checks: { strict: true, contexts: [EXPECTED] },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: null,
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
  const r = evaluateGate(raw, EXPECTED);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(';'), /PR protection/);
});

test('no protection object -> FAIL', () => {
  const r = evaluateGate(null, EXPECTED);
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(';'), /no readback object/);
});
