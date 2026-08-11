# Phase 2 — Acceptance Map

Maps every Phase 2 change BEFORE implementation to frozen Master acceptance
requirements from `docs/master-sot/12_ACCEPTANCE_AND_IMPLEMENTATION.md`, plus
explicit PHASE-LOCAL tests P2-1..P2-18.

Phase 2 = GOVERNED CAPABILITY REGISTRY only.
No live providers, connectors, credential broker, trusted-executor material
commit, DBOS, Agent 0, reconciliation, or business-write autonomy.

Legend:
- **REQUIRED_NOW** — proven by Phase 2 implementation + tests (and/or Phase 1
  regression that must remain green).
- **STRUCTURAL_PREREQUISITE** — Phase 2 preserves/strengthens the primitive but
  full runtime enforcement belongs to a later Foundation phase.
- **DEFERRED_TO_LATER_FOUNDATION_PHASE** — not in Phase 2 scope; not faked.
- **NOT_APPLICABLE** — does not apply to Phase 2 scope.
- **RETEST** — Phase 1 REQUIRED_NOW property must remain green against the
  Phase 2 schema/resolver additions.

Test engine: PGlite (real PostgreSQL WASM) by default; same SQL/migrations/tests
run unchanged against a real multi-process PostgreSQL via `DATABASE_URL`.

## Master acceptance — tenant isolation (retest)
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 1 | Direct DB query A cannot read B | REQUIRED_NOW / RETEST | rls-negative + capability RLS P2-2 |
| 2 | A cannot INSERT/UPDATE/DELETE B | REQUIRED_NOW / RETEST | rls-negative + capability RLS P2-3 |
| 3 | Missing tenant context fails closed | REQUIRED_NOW / RETEST | rls-negative + P2-4 |
| 4 | Runtime role cannot bypass RLS | REQUIRED_NOW / RETEST | rls-negative + P2-5 |
| 5 | Pooled connection A→B cannot leak | REQUIRED_NOW / RETEST | rls-negative regression |
| 6 | Cross-tenant FK/reference rejected | REQUIRED_NOW / RETEST | capability_fallback_refs composite FK P2-6 |

## Master acceptance — authority / grants
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 14 | Revoked/expired grant blocks next action | STRUCTURAL_PREREQUISITE | Capability resolution returns registry metadata only; cannot revive/circumvent grant/authority state (capability-registry authority non-circumvention tests). Full executor grant-check DEFERRED. |

## Master acceptance — idempotency / effects
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 21 | Deterministic idempotency key stable / capability_id identity | REQUIRED_NOW / RETEST | contracts-auth test 19 + capability_id stability tests (no alias mutation) |
| 25 | Provider no idempotency + no observable postcondition cannot auto-retry | STRUCTURAL_PREREQUISITE | Registry/resolver classifies as never autonomously retryable after ambiguity + at least APPROVAL_REQUIRED (P2-11). Actual retry/execution DEFERRED. |

## Master acceptance — kill / revocation / fail closed
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 32 | Revocation between policy decision and commit blocks commit | REQUIRED_NOW / RETEST | authority-kill test 32 |
| 33 | Receipt records commit-time revocation/kill epochs | REQUIRED_NOW / RETEST | authority-kill test 33 |
| 34 | Authority/kill-store outage blocks material writes | REQUIRED_NOW / RETEST | authority-kill test 34 |
| 35 | Zombie worker with stale epoch cannot commit | REQUIRED_NOW / RETEST | authority-kill test 35 |

## Master acceptance — privacy / coding / SOT
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 42 | Immutable receipts contain no raw deletable PII | REQUIRED_NOW / RETEST | contracts-auth test 18; capability metadata uses opaque credential_ref only (P2-10) |
| 44 | Third-party tenant data never becomes global raw durable memory | STRUCTURAL_PREREQUISITE | Capability rows are tenant-owned under RLS; no global durable capability dump for third-party tenants (P2-2) |
| 48 | Build report records approved SOT manifest hash | REQUIRED_NOW / RETEST | `build-binding.json` + `sot-verification.txt` |
| 49 | Coding agent refuses if repo SOT hash mismatches | REQUIRED_NOW / RETEST | `scripts/verify-sot.mjs` + contracts-auth test 20 |

## Explicitly deferred (not Phase 2)
All remaining Master tests from Phase 1 that were DEFERRED_TO_LATER_FOUNDATION_PHASE
remain deferred (Agent 0, DBOS, live providers, executor material commit,
reconciliation, derived-index deletion, recovery, etc.). Not re-listed as
Phase 2 claims.

Connector registry persistence and any new Connector machine contract are
EXPLICITLY OUT OF SCOPE — `06_SYSTEM_CONTRACTS.md` does not define a complete
canonical Connector schema; Phase 2 must not invent one.

## Phase-local acceptance (P2-1..P2-18)
| ID | Test | Disposition | Evidence |
|---|---|---|---|
| P2-1 | Persisted Capability fields match canonical 06 contract | REQUIRED_NOW | capability-registry contract field tests |
| P2-2 | Tenant A cannot enumerate/read Tenant B capability rows | REQUIRED_NOW | capability RLS negative tests |
| P2-3 | Tenant A cannot create/update/delete Tenant B capability rows | REQUIRED_NOW | capability RLS negative tests |
| P2-4 | Missing transaction-local tenant context fails closed | REQUIRED_NOW | capability missing-context tests |
| P2-5 | Runtime DB role remains non-superuser/non-owner/no-BYPASSRLS | REQUIRED_NOW | role introspection + owner checks for `capabilities` |
| P2-6 | Cross-tenant capability references rejected where ownership requires same tenant | REQUIRED_NOW | `capability_fallback_refs` composite FK attack |
| P2-7 | Unknown capability lookup fails closed | REQUIRED_NOW | resolver unknown tests |
| P2-8 | status=disabled cannot resolve as executable | REQUIRED_NOW | resolver disabled tests |
| P2-9 | status=degraded is not silently treated as active | REQUIRED_NOW | resolver degraded tests |
| P2-10 | credential_ref remains opaque; no raw credential-bearing columns/evidence | REQUIRED_NOW | schema + evidence scan + contract tests |
| P2-11 | provider_idempotency!=supported AND postcondition_observable=false never autonomously retryable after ambiguity | REQUIRED_NOW | classification tests |
| P2-12 | control_surface limited to api\|mcp\|cli\|dom\|browser_agent\|computer_use\|human | REQUIRED_NOW | DB CHECK + validation tests |
| P2-13 | reversibility limited to reversible\|compensatable\|irreversible | REQUIRED_NOW | DB CHECK + validation tests |
| P2-14 | provider_idempotency limited to supported\|unsupported\|unknown | REQUIRED_NOW | DB CHECK + validation tests |
| P2-15 | status limited to active\|degraded\|disabled | REQUIRED_NOW | DB CHECK + validation tests |
| P2-16 | capability resolution bound to trusted tenant context; caller cannot select another tenant | REQUIRED_NOW | resolver context-bound tests (no tenant_id arg path) |
| P2-17 | all Phase 1 core/security tests remain green | REQUIRED_NOW | full `npm test` regression |
| P2-18 | business-write autonomy remains disabled; no external execution surface | REQUIRED_NOW | autonomy flag + surface scan tests |

## Implementation mapping (before coding)
| Change | Files (planned) | Acceptance IDs |
|---|---|---|
| Capability persistence + enums + RLS + FORCE RLS | `migrations/0011_capability_registry.sql` | P2-1..P2-6, P2-10, P2-12..P2-15, #1–#6, #44 |
| Contract metadata row for Capability v1 | same migration | P2-1, #48 |
| Tenant-aware fallback FK refs | `capability_fallback_refs` in same migration | P2-6, #6 |
| Deterministic validation + ambiguity classification | `src/contracts/capability.js` | P2-1, P2-10..P2-15, #25 |
| Tenant-context-bound resolver (no caller tenant override) | `src/contracts/capability-resolver.js` | P2-7..P2-9, P2-11, P2-16, #14, #21 |
| Business-write autonomy disabled constant | `src/runtime/autonomy.js` | P2-18 |
| Phase 2 + regression tests | `tests/capability-registry.test.mjs` (+ existing suites) | P2-1..P2-18, retests |
| Evidence pack | `artifacts/phase-2/*`, `scripts/build-evidence-phase2.mjs` | #48, #49 |

## Mechanical summary counts
Computed from rows above (do not hand-edit independently of the tables):

### Master rows tracked in this map
- REQUIRED_NOW / RETEST: 14 (`1,2,3,4,5,6,21,32,33,34,35,42,48,49`)
- STRUCTURAL_PREREQUISITE: 3 (`14,25,44`)
- DEFERRED (explicitly out of Phase 2 claim set): all other Master tests remain as Phase 1 deferred; not counted as Phase 2 deliverables

### Phase-local rows
- REQUIRED_NOW: 18 (`P2-1`..`P2-18`)
- STRUCTURAL_PREREQUISITE: 0
- DEFERRED: 0

### Totals for Phase 2 gate evaluation
- Phase-local REQUIRED_NOW: **18**
- Master REQUIRED_NOW/RETEST preserved: **14**
- Master STRUCTURAL_PREREQUISITE strengthened/preserved: **3**
- Business-write autonomy: **DISABLED**
- External execution surfaces introduced: **0**

Phase 2 gate evaluates only REQUIRED_NOW / RETEST scope plus the STRUCTURAL
proofs claimed above (non-circumvention of authority by resolution; ambiguity
classification without claiming executor behavior).
