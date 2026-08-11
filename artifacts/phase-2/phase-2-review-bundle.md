# Phase 2 — Review Bundle (for Codex)

## Scope
PHASE 2 — GOVERNED CAPABILITY REGISTRY

## SHAs
- BASE SHA: b5d68aa88bb4df251d8a0de15347576a40039390
- REVIEWED IMPLEMENTATION SHA: 7072a4e425fb2c4e537b079a792f9909d40a3d49
- EVIDENCE SHA: pending — evidence/review-only commit created after this binding; not embedded (avoids self-referential Git-SHA loop) (set after evidence commit)

## Mandatory independent inspection
1. SOT verify against approved manifest
   `8454dc306866ced3a5b7f7a827131cbba3587a741b2c948c16e0b1bfde226a87`
2. Diff: `b5d68aa88bb4df251d8a0de15347576a40039390...7072a4e425fb2c4e537b079a792f9909d40a3d49` (implementation only)
3. Migration `0011_capability_registry.sql` (RLS, FORCE RLS, enums, grants)
4. Capability resolver (tenant context only; no caller tenant override)
5. DB role posture (app_runtime non-superuser / no BYPASSRLS / not owner)
6. Tests + acceptance-map.md counts
7. Evidence pack under `artifacts/phase-2/`
8. BUSINESS_WRITE_AUTONOMY = DISABLED

## Codex role
REVIEW-ONLY. Do not act as a concurrent writer.

## Builder claims (verify independently)
- SOT VERIFY: PASS
- Phase 1 regression + Phase 2 tests: PASS
- RLS / tenant isolation: PASS
- Capability contract: PASS
- Unsafe ambiguity classification: PASS
- Raw secrets: NONE
- Business-write autonomy: DISABLED
