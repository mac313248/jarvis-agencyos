# Phase 2 — Governed Capability Registry — Implementation Summary

## SHAs
- BASE SHA (Phase 1 final accepted tip): b5d68aa88bb4df251d8a0de15347576a40039390
- Reviewed implementation SHA: 7072a4e425fb2c4e537b079a792f9909d40a3d49
- Evidence/review-only SHA: pending — evidence/review-only commit created after this binding; not embedded (avoids self-referential Git-SHA loop)
- Branch: phase-2/governed-capability-registry
- Origin: https://github.com/mac313248/jarvis-agencyos.git

NOTE: git_commit_sha in build-binding.json binds to the reviewed implementation
SHA (7072a4e425fb2c4e537b079a792f9909d40a3d49), NOT to the evidence artifact commit.

## SOT
- manifest_sha256: 8454dc306866ced3a5b7f7a827131cbba3587a741b2c948c16e0b1bfde226a87
- SOT verify: PASS
- docs/master-sot/ NOT modified.

## What Phase 2 adds
- Migration 0011: `capabilities` + `capability_fallback_refs` with enum CHECKs,
  RLS + FORCE RLS, app_runtime grants, Capability v1 contract_metadata.
- Deterministic Capability validation + ambiguity classification
  (`src/contracts/capability.js`).
- Tenant-context-bound resolver with no caller tenant override
  (`src/contracts/capability-resolver.js`).
- BUSINESS_WRITE_AUTONOMY = DISABLED (`src/runtime/autonomy.js`).
- Phase 2 tests covering P2-1..P2-18 plus Master retests.

## What Phase 2 deliberately does NOT add
- live providers, connector registry, credential broker, trusted executor
  material commit, DBOS, Agent 0, reconciliation, browser/Orgo, business writes.
- No invented Connector machine contract.

## Gates
- SOT VERIFY: PASS
- Full suite: PASS (pass=65, fail=0)
- RLS / tenant isolation: PASS (see rls-negative-tests.txt)
- Capability contract: PASS (see capability-contract-verification.txt)
- Unsafe ambiguity classification: PASS (never autonomously retryable)
- Raw secrets: NONE
- BUSINESS-WRITE AUTONOMY: DISABLED

## Changed files (base..implementation)
 artifacts/phase-2/acceptance-map.md     | 127 ++++++++
 migrations/0011_capability_registry.sql |  85 +++++
 package.json                            |   8 +-
 scripts/build-evidence-phase2.mjs       | 369 ++++++++++++++++++++++
 src/contracts/capability-resolver.js    | 160 ++++++++++
 src/contracts/capability.js             | 263 ++++++++++++++++
 src/runtime/autonomy.js                 |  28 ++
 tests/capability-registry.test.mjs      | 539 ++++++++++++++++++++++++++++++++
 8 files changed, 1576 insertions(+), 3 deletions(-)

