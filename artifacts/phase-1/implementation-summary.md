# Phase 1 — Secure Core Spine — Implementation Summary

## SHAs (implementation vs evidence)
- Starting main SHA: 5b861f2afefe41090de57ddcdbafd22435160056
- Reviewed implementation SHA (code+migrations+tests whose suite was run): d556690b38b6dd191dd402014b89ad7ea50d59ff
- Evidence/review-only SHA: pending — evidence/review-only commit created after this binding; not embedded (avoids self-referential Git-SHA loop)
- Branch: phase-1/secure-core-spine
- Origin: https://github.com/mac313248/jarvis-agencyos.git

NOTE: git_commit_sha in build-binding.json binds to the reviewed implementation
SHA (d556690b38b6dd191dd402014b89ad7ea50d59ff), NOT to the evidence artifact commit. The evidence artifact
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
- PGlite/PostgreSQL WASM path: ACTUALLY EXECUTED in the Phase 1 test run.
- DATABASE_URL multi-process PostgreSQL path: installable/supported by the same
  code and migrations (pg is a declared dependency; clean npm ci resolves
  import('pg')), but NOT actually exercised in this build environment. No real
  external PostgreSQL cluster was tested.

## What was built
- Migrations 0001-0009: roles + trusted tenant context, tenants/users/memberships
  (RLS + FORCE RLS), owner auth (principals/sessions/MFA), contract metadata +
  SOT build binding, authority/proposal/approval/policy, events/state/evidence,
  receipts/PII subject refs, authority/kill epoch control, second-Codex repair
  (canonical string session-id types + DB-enforced inbound authenticity invariant).
- Least-privilege runtime role app_runtime (not superuser, no BYPASSRLS, not
  table owner). Migrator role owns objects. Owner/contract tables are not
  granted to the runtime role.
- Transaction-local tenant context via set_config(...,true); fails closed when
  missing/invalid; cannot leak across pooled-connection reuse.
- Contract primitives: deterministic canonical IDs + request_hash; deterministic
  idempotency key SHA256(tenant||workflow||step||cap||request_hash); SOT mismatch
  guard; approval binding (proposal_id + request_hash + state version + EXACT
  owner session/principal, canonical string session id) with step-up MFA
  enforcement; inbound authenticity boundary (FAILED/UNKNOWN cannot materialize
  canonical state, DB-enforced CHECK); authority/kill fail-closed epoch
  revalidation.
- No business-write autonomy. No live providers. No DBOS. No Agent 0.

## Test reproducibility
- tests/_helpers.mjs freshCluster now removes any persisted PGlite data dir
  before creating the cluster, so 'npm test' is reproducible across re-runs
  without a manual 'rm -rf .pgdata' (fixed a duplicate-key failure on re-run
  caused by fixed-UUID seeding into a persisted dir).

## Codex reviews
- First Codex review: PASS WITH FIXES (first review; 2 findings addressed)
  - Finding 1 (approval must bind to exact owner session) — addressed.
  - Finding 2 (stale evidence binding) — addressed.
- Second Codex review: PASS WITH FIXES (second review; 4 findings addressed)
  - Finding 1 (DB-backed approval state binding) — addressed.
  - Finding 2 (enforce inbound authenticity) — addressed.
  - Finding 3 (match canonical session-id types) — addressed.
  - Finding 4 (Postgres DATABASE_URL reproducibility) — addressed.
- Current Codex goal review: PASS WITH FIXES (current goal review; 2 findings: 1 addressed, 2 (#45) WAITING_ON_OWNER)
  - Finding 1 (cross-tenant authority read bypass) — addressed: runtime
    reader is now zero-arg and context-bound; old caller-selected reader
    dropped (migration 0010); 6 regression tests R1-R6.
  - Finding 2 (acceptance #45 needs real enforcement) — WAITING_ON_OWNER:
    CI workflow exists but live GitHub branch-protection enforcement
    could not be verified/configured because the Cursor sandbox blocks
    api.github.com (HTTP 403 on CONNECT), so gh cannot validate the macOS
    keychain token or reach the GitHub REST/GraphQL API from inside Cursor.
    Owner-runnable verifier scripts/verify-github-gate.sh (unsets
    GH_TOKEN/GITHUB_TOKEN, uses the keychain gh login) pending run in a
    normal terminal. See artifacts/phase-1/github-gate-verification.txt.
    #45 kept REQUIRED_NOW (not relabeled deferred); not claimed PASS.

## Required negative security tests (all green)
See acceptance-map.md and test-results.txt. 41 tests across 10 suites
(35 prior + 6 new cross-tenant authority regression R1-R6).
Direct RLS attacks against the real runtime role: see rls-negative-tests.txt
(now includes the authority-control cross-tenant path).

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
 artifacts/phase-1/acceptance-map.md                | 131 ++++++
 artifacts/phase-1/build-binding.json               |  21 +
 artifacts/phase-1/codex-review-prompt.txt          |  50 ++
 artifacts/phase-1/github-gate-verification.txt     |  97 ++++
 artifacts/phase-1/implementation-summary.md        | 126 +++++
 artifacts/phase-1/migration-verification.txt       |  14 +
 artifacts/phase-1/phase-1-review-bundle.md         | 124 +++++
 artifacts/phase-1/rls-negative-tests.txt           |  40 ++
 artifacts/phase-1/sot-verification.txt             |  17 +
 artifacts/phase-1/test-results.txt                 | 333 ++++++++++++++
 migrations/0001_roles_and_tenant_context.sql       |  50 ++
 migrations/0002_tenants_users_memberships.sql      |  54 +++
 migrations/0003_owner_auth.sql                     |  38 ++
 .../0004_contract_metadata_and_sot_binding.sql     |  26 ++
 migrations/0005_authority_proposal_approval.sql    |  99 ++++
 migrations/0006_events_state_evidence.sql          |  82 ++++
 migrations/0007_receipts_pii.sql                   |  63 +++
 migrations/0008_kill_authority_epoch.sql           |  36 ++
 migrations/0009_second_codex_repair.sql            |  16 +
 .../0010_authority_runtime_context_bound.sql       |  31 ++
 package-lock.json                                  | 168 +++++++
 package.json                                       |  18 +
 scripts/build-evidence.mjs                         | 241 ++++++++++
 scripts/migrate.mjs                                |  18 +
 scripts/verify-github-gate.sh                      |  96 ++++
 scripts/verify-sot.mjs                             |  22 +
 src/contracts/approval.js                          |  99 ++++
 src/contracts/authority.js                         |  90 ++++
 src/contracts/events.js                            |  51 ++
 src/contracts/ids.js                               |  44 ++
 src/contracts/sot-binding.js                       |  71 +++
 src/db/index.js                                    | 122 +++++
 src/db/migrator.js                                 |  59 +++
 src/security/tenant-context.js                     |  40 ++
 tests/_helpers.mjs                                 |  63 +++
 tests/authority-kill.test.mjs                      | 190 ++++++++
 tests/contracts-auth.test.mjs                      | 511 +++++++++++++++++++++
 tests/rls-negative.test.mjs                        | 183 ++++++++
 40 files changed, 3573 insertions(+)

