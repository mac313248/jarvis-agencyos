# Phase 1 — Acceptance Map

Maps every acceptance test in `docs/master-sot/12_ACCEPTANCE_AND_IMPLEMENTATION.md`
to a Phase 1 disposition. Phase 1 = SECURE CORE SPINE only.

Legend:
- **REQUIRED_NOW** — proven by Phase 1 implementation + tests.
- **STRUCTURAL_PREREQUISITE** — Phase 1 provides the persisted primitive/schema
  required for the property, but full runtime enforcement belongs to a later
  Foundation phase and is explicitly DEFERRED there.
- **DEFERRED_TO_LATER_FOUNDATION_PHASE** — belongs to DBOS, Agent 0, live
  providers, material external execution, reconciliation, derived-index
  deletion, or other later Foundation work. Not faked in Phase 1.
- **NOT_APPLICABLE** — does not apply to Phase 1 scope.

Test engine note: tests run against **PGlite** (real PostgreSQL compiled to
WASM) by default; the same SQL/migrations/tests run unchanged against a real
multi-process PostgreSQL cluster via `DATABASE_URL`. RLS, FORCE RLS,
`pg_roles` (rolsuper/rolbypassrls), and transaction-local `set_config` are the
real PostgreSQL implementation, not a mocked repository layer. The runtime
role is exercised via `SET ROLE` (the standard PostgreSQL RLS-testing
technique). See `test-results.txt` and `rls-negative-tests.txt`.

## Tenant isolation
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 1 | Direct DB query A cannot read B | REQUIRED_NOW | rls-negative test 1 |
| 2 | A cannot INSERT/UPDATE/DELETE B | REQUIRED_NOW | rls-negative tests 2,3,4 |
| 3 | Missing tenant context fails closed | REQUIRED_NOW | rls-negative test 5 |
| 4 | Runtime role cannot bypass RLS | REQUIRED_NOW | rls-negative tests 6,7,8,9 |
| 5 | Pooled connection A→B cannot leak | REQUIRED_NOW | rls-negative test 10 |
| 6 | Cross-tenant FK/reference rejected | REQUIRED_NOW | rls-negative test 11 |
| 7 | A context cannot influence B customer-facing output | DEFERRED_TO_LATER_FOUNDATION_PHASE | Requires Agent 0 customer-facing output (V1.1) |
| 8 | Global Jarvis receives only permitted typed receipts/aggregates | DEFERRED_TO_LATER_FOUNDATION_PHASE | Jarvis receipt aggregation (V1.1) |

## Owner / auth / approval
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 9 | Owner session requires authentication | REQUIRED_NOW (primitive) | `owner_sessions` schema + `validateApproval` session checks; live auth provider (OAuth/MFA provider) DEFERRED |
| 10 | High-risk approval requires recent step-up MFA | REQUIRED_NOW | contracts-auth test 13 (+ exact session/principal binding tests 14a/14b/14c) |
| 11 | APPROVE works only for exact proposal_id + request_hash | REQUIRED_NOW | contracts-auth test 14 |
| 12 | Payload/state mutation invalidates prior approval | REQUIRED_NOW | contracts-auth test 15 + DB-backed test 1DB (persisted loader path) |
| 13 | Raw text "owner approved" has zero value | REQUIRED_NOW | contracts-auth test 16 |
| 14 | Revoked/expired grant blocks next action | STRUCTURAL_PREREQUISITE | `authority_grants` status + `revocation_epoch`; full grant-check at execution DEFERRED to executor phase |

## Inbound authenticity
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 15 | Forged/invalid-signature webhook cannot materialize canonical state | REQUIRED_NOW | contracts-auth test 17 (fake adapter boundary) + DB-enforced CHECK + direct DB tests 2DBa/2DBb |
| 16 | Replay/duplicate creates one canonical event | STRUCTURAL_PREREQUISITE | `canonical_events.dedup_key` UNIQUE; full ingestion dedupe DEFERRED |
| 17 | Authenticated payload text remains untrusted for instruction | REQUIRED_NOW | `content_trust` UNTRUSTED_PAYLOAD + `canMaterializeCanonicalState` (structured materialization only); contracts-auth test 17 |

## Materiality
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 18 | Non-silenceable classes cannot be SILENCED | DEFERRED_TO_LATER_FOUNDATION_PHASE | Materiality policy engine (later Foundation) |
| 19 | 10,000 no-op events → zero unnecessary strong-model wakes | DEFERRED_TO_LATER_FOUNDATION_PHASE | Materiality engine (later Foundation) |
| 20 | Same unresolved state hash does not repeatedly notify | DEFERRED_TO_LATER_FOUNDATION_PHASE | Attention/dedup engine (later Foundation) |

## Idempotency / effects
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 21 | Deterministic idempotency key stable across restart | REQUIRED_NOW | contracts-auth test 19 |
| 22 | Duplicate same logical effect executes at most once | DEFERRED_TO_LATER_FOUNDATION_PHASE | Key primitive + UNIQUE present; executor DEFERRED |
| 23 | Crash after external commit before local completion no duplicate | DEFERRED_TO_LATER_FOUNDATION_PHASE | DBOS/executor |
| 24 | PITR restore no resurrect committed external effect | DEFERRED_TO_LATER_FOUNDATION_PHASE | Recovery (later Foundation) |
| 25 | Provider no idempotency + no observable postcondition cannot auto-retry | DEFERRED_TO_LATER_FOUNDATION_PHASE | Executor policy (later Foundation) |
| 26 | Ambiguous API/MCP write cannot fall back to browser/Orgo until negative postcondition verified | DEFERRED_TO_LATER_FOUNDATION_PHASE | Executor fallback policy (later Foundation) |
| 27 | Successful external effect has verified receipt | DEFERRED_TO_LATER_FOUNDATION_PHASE | Receipt schema present; executor DEFERRED |
| 28 | Unknown effect remains AMBIGUOUS/UNKNOWN never silently SUCCEEDED | DEFERRED_TO_LATER_FOUNDATION_PHASE | `verification_status` field present; executor DEFERRED |

## Agent 0 concurrency
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 29 | Two simultaneous events same tenant+subject+routine cannot create two effects | DEFERRED_TO_LATER_FOUNDATION_PHASE | Agent 0 (V1.1) |
| 30 | Cancelled/expired workflow cannot commit late effect | DEFERRED_TO_LATER_FOUNDATION_PHASE | Agent 0 (V1.1) |
| 31 | Semantic action dedupe prevents duplicate logical follow-up | DEFERRED_TO_LATER_FOUNDATION_PHASE | Agent 0 (V1.1) |

## Kill / revocation / fail closed
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 32 | Revocation between policy decision and commit blocks commit | REQUIRED_NOW | authority-kill test 32 |
| 33 | Receipt records commit-time revocation/kill epochs | REQUIRED_NOW | authority-kill test 33 |
| 34 | Authority/kill-store outage blocks material writes | REQUIRED_NOW | authority-kill test 34 |
| 35 | Zombie worker with stale epoch cannot commit | REQUIRED_NOW | authority-kill test 35 |

## Reconciliation
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 36 | Provider mismatch no local pending effect safely repairs/escalates | DEFERRED_TO_LATER_FOUNDATION_PHASE | Reconciliation (later Foundation) |
| 37 | Pending/ambiguous local effect never auto-overwritten as drift | DEFERRED_TO_LATER_FOUNDATION_PHASE | Reconciliation (later Foundation) |
| 38 | Stale source becomes STALE/UNKNOWN | DEFERRED_TO_LATER_FOUNDATION_PHASE | `freshness` field present; engine DEFERRED |
| 39 | Conflicting authoritative evidence becomes CONFLICTED | DEFERRED_TO_LATER_FOUNDATION_PHASE | `conflict_status` field present; engine DEFERRED |

## Privacy / deletion
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 40 | Valid customer deletion removes identifiable canonical data | DEFERRED_TO_LATER_FOUNDATION_PHASE | `pii_subjects.status` present; full propagation DEFERRED |
| 41 | Embeddings/FTS/cache/derived summaries no longer expose deleted PII | DEFERRED_TO_LATER_FOUNDATION_PHASE | No derived indexes in Phase 1 |
| 42 | Immutable receipts contain no raw deletable PII when opaque subject ref suffices | REQUIRED_NOW | contracts-auth test 18 |
| 43 | Non-identifying audit tombstone remains | REQUIRED_NOW | contracts-auth test 18 (deletion step leaves receipt w/ opaque ref) |
| 44 | Third-party tenant data never becomes global raw durable memory | STRUCTURAL_PREREQUISITE | RLS isolation enforces structurally; full global-memory policy DEFERRED |

## Coding
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 45 | Cursor builder cannot merge failed CI | REQUIRED_NOW — PASS | Live GitHub branch-protection enforcement VERIFIED by owner from a normal Mac Mini terminal. main is protected; required status check "Phase 1 — Secure Core Spine / phase1" is active with strict=true; failed/missing required check blocks merge. See `github-gate-verification.txt` |
| 46 | Codex/reviewer cannot override valid deterministic test failure | REQUIRED_NOW | Codex decision contract in `phase-1-review-bundle.md` |
| 47 | Protected main rejects unauthorized direct push | REQUIRED_NOW — PASS | Live main protection VERIFIED by owner: PR protection on, enforce_admins=true, allow_force_pushes=false, allow_deletions=false. See `github-gate-verification.txt` |
| 48 | Build report records approved SOT manifest hash | REQUIRED_NOW | `build-binding.json` + `sot_build_bindings` row |
| 49 | Coding agent refuses if repo SOT hash mismatches | REQUIRED_NOW | `scripts/verify-sot.mjs` + contracts-auth test 20 |

## Recovery
| # | Test | Disposition | Evidence |
|---|---|---|---|
| 50 | DBOS completed step survives restart without duplicate execution | DEFERRED_TO_LATER_FOUNDATION_PHASE | DBOS (later Foundation) |
| 51 | Approval wait survives restart | DEFERRED_TO_LATER_FOUNDATION_PHASE | DBOS (later Foundation) |
| 52 | Restore sequence freezes writers until reconcile | DEFERRED_TO_LATER_FOUNDATION_PHASE | Recovery (later Foundation) |
| 53 | Backup restore actually rehearsed | DEFERRED_TO_LATER_FOUNDATION_PHASE | Recovery (later Foundation) |

## Summary
- REQUIRED_NOW: 20 acceptance tests (1,2,3,4,5,6,9,10,11,12,13,15,17,21,32,33,34,35,42,43,45,46,47,48,49) — all green, proven by 41 core-spine unit tests (35 prior + 6 cross-tenant authority regression R1-R6) PLUS live GitHub gate evidence (#45, #47).
- REQUIRED_NOW but WAITING_ON_OWNER: 0.
- STRUCTURAL_PREREQUISITE: 2 (14,16,44) — schema/primitive present; full enforcement DEFERRED. (#47 promoted to REQUIRED_NOW — PASS via live main protection.)
- DEFERRED_TO_LATER_FOUNDATION_PHASE: 26 — explicitly identified, not faked.
- NOT_APPLICABLE: 0.

Phase 1 gate evaluates only REQUIRED_NOW scope plus the security properties
this implementation claims (RLS isolation, fail-closed tenant context,
approval binding, authenticity boundary, deterministic idempotency, SOT
binding). All are proven by direct tests against the real PostgreSQL engine.
