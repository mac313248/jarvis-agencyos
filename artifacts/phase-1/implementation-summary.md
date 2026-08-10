# Phase 1 — Secure Core Spine — Implementation Summary

## SHAs (implementation vs evidence)
- Starting main SHA: 5b861f2afefe41090de57ddcdbafd22435160056
- Reviewed implementation SHA (code+migrations+tests whose suite was run): 61f5fb6cb9db45920392e2e0c4f5a964a59224c3
- Evidence/review-only SHA: pending — evidence/review-only commit created after this binding; not embedded (avoids self-referential Git-SHA loop)
- Branch: phase-1/secure-core-spine
- Origin: https://github.com/mac313248/jarvis-agencyos.git

NOTE: git_commit_sha in build-binding.json binds to the reviewed implementation
SHA (61f5fb6cb9db45920392e2e0c4f5a964a59224c3), NOT to the evidence artifact commit. The evidence artifact
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

## Codex reviews
- First Codex review: PASS WITH FIXES (first review; 2 findings addressed)
  - Finding 1 (approval must bind to exact owner session) — addressed: exact
    session_id + owner_principal_id binding + 3 negative tests.
  - Finding 2 (stale evidence binding) — addressed: evidence bound to reviewed
    implementation SHA; self-referential SHA loop avoided.
- Second Codex review: PASS WITH FIXES (second review; 4 findings addressed)
  - Finding 1 (DB-backed approval state binding) — addressed: loadProposal()
    now selects precondition_snapshot_ref; DB-backed test persists
    proposal+approval+session, loads via real loaders, mutates state, reloads,
    proves prior approval invalid.
  - Finding 2 (enforce inbound authenticity) — addressed: DB CHECK constraint
    canonical_events_no_materialize_on_failed_auth rejects
    materialized_state=true with FAILED/UNKNOWN; direct DB negative tests.
  - Finding 3 (match canonical session-id types) — addressed:
    owner_sessions.session_id + approval_decisions.owner_auth_session_id
    altered to text; non-UUID string session id test.
  - Finding 4 (Postgres DATABASE_URL reproducibility) — addressed: pg declared
    as direct dependency; package-lock refreshed; clean npm ci resolves
    import('pg'); evidence wording distinguishes PGlite (executed) from
    DATABASE_URL (supported, not executed).

## Required negative security tests (all green)
See acceptance-map.md and test-results.txt. 35 tests across 9 suites
(29 prior + 6 new: 14d non-UUID session, 1DB DB-backed state invalidation,
 2DBa/2DBb/2DBc/2DBd inbound authenticity DB enforcement).
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
 artifacts/phase-1/acceptance-map.md                | 130 ++++++
 artifacts/phase-1/build-binding.json               |  16 +
 artifacts/phase-1/codex-review-prompt.txt          |  50 ++
 artifacts/phase-1/implementation-summary.md        | 106 +++++
 artifacts/phase-1/migration-verification.txt       |  12 +
 artifacts/phase-1/phase-1-review-bundle.md         | 120 +++++
 artifacts/phase-1/rls-negative-tests.txt           |  37 ++
 artifacts/phase-1/sot-verification.txt             |  17 +
 artifacts/phase-1/test-results.txt                 | 240 ++++++++++
 migrations/0001_roles_and_tenant_context.sql       |  50 ++
 migrations/0002_tenants_users_memberships.sql      |  54 +++
 migrations/0003_owner_auth.sql                     |  38 ++
 .../0004_contract_metadata_and_sot_binding.sql     |  26 ++
 migrations/0005_authority_proposal_approval.sql    |  99 ++++
 migrations/0006_events_state_evidence.sql          |  82 ++++
 migrations/0007_receipts_pii.sql                   |  63 +++
 migrations/0008_kill_authority_epoch.sql           |  36 ++
 migrations/0009_second_codex_repair.sql            |  16 +
 package-lock.json                                  | 168 +++++++
 package.json                                       |  18 +
 scripts/build-evidence.mjs                         | 211 +++++++++
 scripts/migrate.mjs                                |  18 +
 scripts/verify-sot.mjs                             |  22 +
 src/contracts/approval.js                          |  99 ++++
 src/contracts/authority.js                         |  50 ++
 src/contracts/events.js                            |  51 ++
 src/contracts/ids.js                               |  44 ++
 src/contracts/sot-binding.js                       |  71 +++
 src/db/index.js                                    | 122 +++++
 src/db/migrator.js                                 |  59 +++
 src/security/tenant-context.js                     |  40 ++
 tests/_helpers.mjs                                 |  56 +++
 tests/authority-kill.test.mjs                      |  97 ++++
 tests/contracts-auth.test.mjs                      | 511 +++++++++++++++++++++
 tests/rls-negative.test.mjs                        | 183 ++++++++
 37 files changed, 3051 insertions(+)

