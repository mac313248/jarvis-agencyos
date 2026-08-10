# Phase 1 — Secure Core Spine — Implementation Summary

## SHAs (implementation vs evidence)
- Starting main SHA: 5b861f2afefe41090de57ddcdbafd22435160056
- Reviewed implementation SHA (code+migrations+tests whose suite was run): 20c64b759c3f6aced3879e2872cca76326e58914
- Evidence/review-only SHA: pending — evidence/review-only commit created after this binding; not embedded (avoids self-referential Git-SHA loop)
- Branch: phase-1/secure-core-spine
- Origin: https://github.com/mac313248/jarvis-agencyos.git

NOTE: git_commit_sha in build-binding.json binds to the reviewed implementation
SHA (20c64b759c3f6aced3879e2872cca76326e58914), NOT to the evidence artifact commit. The evidence artifact
cannot cryptographically contain its own final commit SHA; any later commit is
evidence/review-only and does not modify implementation.

## SOT
- manifest_sha256: 8454dc306866ced3a5b7f7a827131cbba3587a741b2c948c16e0b1bfde226a87
- SOT verify: PASS (all 15 SOT files match manifest)
- docs/master-sot/ NOT modified.

## Engine
- Test engine: PGlite (real PostgreSQL compiled to WASM). Runs in-process; the
  RLS engine, pg_roles catalog, FORCE RLS, BYPASSRLS, and transaction-local
  set_config are the real PostgreSQL implementation. Same migrations/tests
  run unchanged against a real multi-process PostgreSQL via DATABASE_URL.
- server_version: 16.4

## What was built
- Migrations 0001-0008: roles + trusted tenant context, tenants/users/memberships
  (RLS + FORCE RLS), owner auth (principals/sessions/MFA), contract metadata +
  SOT build binding, authority/proposal/approval/policy, events/state/evidence,
  receipts/PII subject refs, authority/kill epoch control.
- Least-privilege runtime role app_runtime (not superuser, no BYPASSRLS, not
  table owner). Migrator role owns objects. Owner/contract tables are not
  granted to the runtime role.
- Transaction-local tenant context via set_config(...,true); fails closed when
  missing/invalid; cannot leak across pooled-connection reuse.
- Contract primitives: deterministic canonical IDs + request_hash; deterministic
  idempotency key SHA256(tenant||workflow||step||cap||request_hash); SOT mismatch
  guard; approval binding (proposal_id + request_hash + state version + EXACT
  owner session/principal) with step-up MFA enforcement; inbound authenticity
  boundary (FAILED/UNKNOWN cannot materialize canonical state); authority/kill
  fail-closed epoch revalidation.
- No business-write autonomy. No live providers. No DBOS. No Agent 0.

## Codex first review
- Verdict: PASS WITH FIXES (first review; 2 findings addressed)
- Findings addressed:
  1. Approval now binds to the exact owner session (session_id) and principal
     (owner_principal_id) recorded on ApprovalDecision. Added 3 negative tests.
  2. Stale evidence binding repaired: evidence now binds to the reviewed
     implementation SHA; wording corrected; self-referential SHA loop avoided;
     first Codex verdict + findings recorded.

## Required negative security tests (all green)
See acceptance-map.md and test-results.txt. 29 tests across 7 suites
(26 original + 3 new approval session/principal binding tests).
Direct RLS attacks against the real runtime role: see rls-negative-tests.txt.

## Known deferrals
See acceptance-map.md: 26 tests DEFERRED_TO_LATER_FOUNDATION_PHASE, 4
STRUCTURAL_PREREQUISITE (schema present, full enforcement later). None faked.

## No business-write autonomy
- No customer contact, no GHL/Meta/Google writes, no spend/price/refund changes,
  no T2/T3/T4 routines, no Agent 0 autonomy, no browser/Orgo business fallback.
- Only mocks/test fixtures/local infrastructure used.

## Changed files
 .github/workflows/phase-1.yml                      |  33 ++
 .gitignore                                         |   6 +
 artifacts/phase-1/acceptance-map.md                | 130 ++++++++
 artifacts/phase-1/build-binding.json               |  12 +
 artifacts/phase-1/codex-review-prompt.txt          |  50 +++
 artifacts/phase-1/implementation-summary.md        |  88 ++++++
 artifacts/phase-1/migration-verification.txt       |  12 +
 artifacts/phase-1/phase-1-review-bundle.md         | 120 ++++++++
 artifacts/phase-1/rls-negative-tests.txt           |  37 +++
 artifacts/phase-1/sot-verification.txt             |  17 ++
 artifacts/phase-1/test-results.txt                 | 222 ++++++++++++++
 migrations/0001_roles_and_tenant_context.sql       |  50 +++
 migrations/0002_tenants_users_memberships.sql      |  54 ++++
 migrations/0003_owner_auth.sql                     |  38 +++
 .../0004_contract_metadata_and_sot_binding.sql     |  26 ++
 migrations/0005_authority_proposal_approval.sql    |  99 ++++++
 migrations/0006_events_state_evidence.sql          |  82 +++++
 migrations/0007_receipts_pii.sql                   |  63 ++++
 migrations/0008_kill_authority_epoch.sql           |  36 +++
 package-lock.json                                  |  21 ++
 package.json                                       |  17 ++
 scripts/build-evidence.mjs                         | 179 +++++++++++
 scripts/migrate.mjs                                |  18 ++
 scripts/verify-sot.mjs                             |  22 ++
 src/contracts/approval.js                          |  99 ++++++
 src/contracts/authority.js                         |  50 +++
 src/contracts/events.js                            |  51 ++++
 src/contracts/ids.js                               |  44 +++
 src/contracts/sot-binding.js                       |  71 +++++
 src/db/index.js                                    | 122 ++++++++
 src/db/migrator.js                                 |  59 ++++
 src/security/tenant-context.js                     |  40 +++
 tests/_helpers.mjs                                 |  56 ++++
 tests/authority-kill.test.mjs                      |  97 ++++++
 tests/contracts-auth.test.mjs                      | 337 +++++++++++++++++++++
 tests/rls-negative.test.mjs                        | 183 +++++++++++
 36 files changed, 2641 insertions(+)

