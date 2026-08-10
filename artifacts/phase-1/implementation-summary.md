# Phase 1 — Secure Core Spine — Implementation Summary

## Starting / ending state
- Starting main SHA: 5b861f2afefe41090de57ddcdbafd22435160056
- Phase 1 branch: phase-1/secure-core-spine
- Final branch SHA: 5b861f2afefe41090de57ddcdbafd22435160056
- Origin: https://github.com/mac313248/jarvis-agencyos.git

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
  guard; approval binding (proposal_id + request_hash + state version) with
  step-up MFA enforcement; inbound authenticity boundary (FAILED/UNKNOWN cannot
  materialize canonical state); authority/kill fail-closed epoch revalidation.
- No business-write autonomy. No live providers. No DBOS. No Agent 0.

## Required negative security tests (all green)
See acceptance-map.md and test-results.txt. 26 tests across 7 suites.
Direct RLS attacks against the real runtime role: see rls-negative-tests.txt.

## Known deferrals
See acceptance-map.md: 26 tests DEFERRED_TO_LATER_FOUNDATION_PHASE, 4
STRUCTURAL_PREREQUISITE (schema present, full enforcement later). None faked.

## No business-write autonomy
- No customer contact, no GHL/Meta/Google writes, no spend/price/refund changes,
  no T2/T3/T4 routines, no Agent 0 autonomy, no browser/Orgo business fallback.
- Only mocks/test fixtures/local infrastructure used.

## Changed files

