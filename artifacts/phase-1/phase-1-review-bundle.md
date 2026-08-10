# Phase 1 — Review Bundle (for independent Codex gate)

## Decision contract for the reviewer
Return exactly one primary verdict:
- `PASS`
- `PASS WITH FIXES`
- `FAIL`

Only flag material:
- SOT contradiction;
- security/tenant isolation flaw;
- missing required Phase 1 acceptance coverage;
- invalid approval/auth binding;
- unsafe authority/kill behavior;
- incorrect idempotency;
- unsupported completion claim;
- PII/audit violation;
- broken migration/reproducibility;
- code that silently makes a major architecture decision.

Do not redesign the architecture for novelty. If fixes are needed, give the
smallest concrete fix list.

## Scope under review
Phase 1 = SECURE CORE SPINE only. Business-write autonomy, DBOS, Agent 0, live
providers, material external execution, reconciliation, and derived-index
deletion are explicitly DEFERRED (see acceptance-map.md) and are NOT in scope.

## What to review
1. `artifacts/phase-1/acceptance-map.md` — every acceptance test disposition.
2. `artifacts/phase-1/test-results.txt` — full test output.
3. `artifacts/phase-1/rls-negative-tests.txt` — direct RLS attack results +
   role/RLS introspection (runtime role not superuser, no BYPASSRLS, not owner;
   FORCE RLS on all tenant-owned tables).
4. `artifacts/phase-1/migration-verification.txt` — clean-db migration.
5. `artifacts/phase-1/sot-verification.txt` + `build-binding.json` — SOT binding.
6. `artifacts/phase-1/implementation-summary.md` — narrative + changed files.
7. Complete diff from starting main (`5b861f2...`) to branch HEAD.
8. All migrations under `migrations/`.
9. All source under `src/`.
10. All tests under `tests/`.

## Relevant SOT excerpts to consult
- `docs/master-sot/01_ARCHITECTURE_LOCKS.md` — RLS + FORCE RLS + least-privilege
  runtime roles + transaction-local tenant context + fail-closed.
- `docs/master-sot/06_SYSTEM_CONTRACTS.md` — canonical contracts (OwnerAuthContext,
  AuthorityGrant, ActionProposal, ApprovalDecision, PolicyDecision, CanonicalEvent,
  CurrentStateRecord, ExecutionReceipt, PII subject_ref, deterministic idempotency
  key, SOTBuildBinding).
- `docs/master-sot/07_AUTHORITY_SECURITY_EXECUTION.md` — model is never a security
  boundary; trusted executor flow; kill/revocation TOCTOU; fail-closed; PII/erasure.
- `docs/master-sot/12_ACCEPTANCE_AND_IMPLEMENTATION.md` — master acceptance tests +
  V1.0 FOUNDATION scope + "deliberately not built in V1.0".

## Phase 1 claims being verified
- PostgreSQL RLS is the PRIMARY tenant boundary; app filtering is defense-in-depth.
- Runtime role: not superuser, no BYPASSRLS, not a protected-table owner.
- Tenant context is transaction-local; cannot leak across pooled-connection reuse;
  fails closed when missing/invalid.
- Client/model-supplied tenant ID cannot override trusted context.
- High-risk approval requires recent unexpired step-up MFA + exact
  proposal_id + request_hash + state-version binding; raw text approval = no value.
- FAILED/UNKNOWN authenticity on an auth-required event cannot materialize
  canonical business state.
- Immutable receipts use opaque subject_ref; no raw deletable PII required.
- Deterministic idempotency key SHA256(tenant||workflow||step||cap||request_hash)
  stable across restart.
- Authority/kill: fail-closed on outage; epochs revalidated before commit and
  recorded in receipt.
- SOT mismatch guard refuses continuation; build records approved manifest hash.
- No business-write autonomy enabled.

## Test engine disclosure
Tests run against PGlite (real PostgreSQL compiled to WASM) by default, and
optionally against a real multi-process PostgreSQL cluster via DATABASE_URL
(same SQL/migrations/tests). The runtime role is exercised via SET ROLE, the
standard PostgreSQL RLS-testing technique. RLS, FORCE RLS, pg_roles
(rolsuper/rolbypassrls), and transaction-local set_config are the real
PostgreSQL implementation — not a mocked repository layer.

## Known deferrals / uncertainties
- 26 acceptance tests DEFERRED_TO_LATER_FOUNDATION_PHASE (DBOS, Agent 0, live
  providers, material external execution, reconciliation, derived-index deletion,
  materiality engine, recovery). See acceptance-map.md.
- 4 STRUCTURAL_PREREQUISITE (schema/primitive present; full runtime enforcement
  belongs to a later Foundation phase): #14 grant-check at execution, #16 replay
  dedupe at ingestion, #44 global-memory policy, #47 branch protection (needs
  owner GitHub settings — see OWNER ACTION note below).
- Live owner auth provider (OAuth/MFA provider) is DEFERRED; Phase 1 provides the
  session/MFA representation + binding primitives, not a live auth backend.
- A real multi-process PostgreSQL cluster was not available in the build sandbox
  (Homebrew Cellar not writable; SysV shmget blocked by the Cursor sandbox). The
  same migrations/tests run unchanged against one when DATABASE_URL is provided.

## OWNER ACTION note (not blocking Phase 1 gate)
Acceptance #47 (protected main rejects unauthorized direct push) requires GitHub
branch protection configured on the repository settings. This is an owner
GitHub-settings action, not something code can self-serve. Recommended:
enable branch protection on `main` requiring the Phase 1 CI check + a passing
review before merge. This does not block the Phase 1 secure-core-spine gate.

## Reviewer verdict
- Verdict: _(pending — see OWNER ACTION below)_

## Codex gate status: WAITING_ON_OWNER (sandbox-blocked)
Codex CLI v0.146.0 is installed and authenticated (ChatGPT auth mode, confirmed
via `codex doctor`). However, running `codex review` / `codex exec` from inside
the Cursor build sandbox fails with:
  `Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)`
and the model provider endpoint (chatgpt.com) is unreachable through the sandbox
proxy (HTTP 403). The sandbox blocks the syscalls Codex needs and the network it
requires; this cannot be self-served by the builder.

The review bundle is complete and ready. The single owner action required is to
run the Codex review from a normal (non-sandboxed) terminal:

  cd ~/Projects/jarvis-agencyos && codex exec "$(cat artifacts/phase-1/codex-review-prompt.txt)"

Then paste the verdict back. Cursor will apply any PASS WITH FIXES / FAIL
findings via the smallest corrections and re-run the suite + Codex review.
