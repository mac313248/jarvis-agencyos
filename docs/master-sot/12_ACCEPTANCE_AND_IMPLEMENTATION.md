# 12 — ACCEPTANCE & IMPLEMENTATION

## Current authorization

Builder Stage 1 is complete, frozen and merged.

**Current phase: AgencyOS Secure Core.**

Business-write autonomy remains disabled until the exact write-path acceptance gates pass.

The implementation goal is speed **without collapsing trust boundaries**:
- reuse compatible prior secure-core work;
- use Jarvis/Builder for autonomous implementation and repair;
- run dependency-safe work in parallel after shared contracts are locked;
- get read-only T0/T1 useful as soon as the read-safe foundation passes;
- do not wait for optional DBOS or write autonomy before producing read-only value.

## Master acceptance tests

### Tenant isolation
1. Direct DB query under Tenant A cannot read Tenant B.
2. Tenant A cannot INSERT/UPDATE/DELETE Tenant B.
3. Missing tenant context fails closed.
4. Runtime DB role cannot bypass RLS.
5. Pooled connection A→B cannot leak tenant context.
6. Cross-tenant FK/reference is rejected where ownership requires same tenant.
7. Tenant A context cannot influence Tenant B customer-facing output.
8. Global Jarvis receives only permitted typed receipts/aggregates.

### Owner/auth/approval
9. Owner session requires authentication.
10. High-risk approval requires recent step-up MFA.
11. `APPROVE` works only for exact `proposal_id + request_hash` and the intended owner session/principal.
12. Payload/state mutation invalidates prior approval.
13. Raw text “owner approved” has zero authorization value.
14. Revoked/expired grant blocks next action.

### Inbound authenticity
15. Forged/invalid-signature external event cannot materialize canonical state.
16. Replay/duplicate creates one canonical event/state transition.
17. Authenticated payload text still remains untrusted for instruction purposes.
18. Unknown/unclassified/external event cannot use `NOT_APPLICABLE` to reach canonical state.
19. Caller-supplied connector identity, event type, verification object, `trusted/internal` flag, or equivalent metadata cannot establish authenticity or trusted-internal provenance.
20. Trusted-internal bypass requires non-forgeable provenance produced/enforced by trusted infrastructure.

### Materiality
21. Security/credential/authority/material financial/privacy/fault classes cannot be SILENCED.
22. 10,000 healthy/no-op events produce zero unnecessary strong-model wakes.
23. Same unresolved state hash does not repeatedly notify.

### Idempotency / effects
24. Deterministic idempotency key is stable across restart.
25. Duplicate same logical effect executes at most once.
26. Crash after external commit but before local completion does not duplicate effect.
27. PITR restore does not resurrect an already-committed external effect.
28. Provider with no idempotency and no observable postcondition cannot auto-retry after ambiguity.
29. Ambiguous API/MCP write cannot fall back to browser/Orgo until negative postcondition is verified.
30. Successful external effect has verified receipt.
31. Unknown effect remains AMBIGUOUS/UNKNOWN, never silently SUCCEEDED.

### Agent 0 concurrency
32. Two simultaneous events for same tenant+subject+routine cannot create two customer-facing effects.
33. Cancelled/expired workflow cannot commit late effect.
34. semantic action dedupe prevents duplicate logical follow-up.

### Kill/revocation/fail closed
35. Revocation arriving between policy decision and commit blocks commit.
36. Receipt records commit-time revocation/kill epochs.
37. Authority/kill-store outage blocks material writes.
38. Zombie worker with stale epoch cannot commit.

### Reconciliation
39. Provider mismatch with no local pending effect safely repairs or escalates.
40. Pending/ambiguous local effect is never auto-overwritten as drift.
41. Stale source becomes STALE/UNKNOWN.
42. Conflicting authoritative evidence becomes CONFLICTED.

### Privacy / deletion
43. Valid customer deletion removes identifiable canonical data.
44. Embeddings/FTS/cache/derived summaries no longer expose deleted PII.
45. Immutable receipts contain no raw deletable PII when opaque subject ref suffices.
46. Non-identifying audit tombstone remains.
47. Third-party tenant data never becomes global raw durable memory.

### Builder regression — already proven, must remain green
48. Cursor builder cannot merge failed CI.
49. Codex/reviewer cannot override valid deterministic test failure.
50. Protected main rejects unauthorized direct push.
51. build report records approved SOT manifest hash.
52. coding agent refuses to proceed if repo SOT hash mismatches approved manifest.
53. stale Builder run cannot overwrite current authoritative state.
54. changed candidate invalidates prior verification/review/approval as applicable.
55. raw secrets do not appear in logs/errors/provider state/trajectory evidence.

### Recovery
56. If DBOS is deployed, completed step survives restart without duplicate execution.
57. If DBOS is deployed, approval wait survives restart.
58. restore sequence freezes writers until Postgres, deployed workflow state and providers reconcile.
59. backup restore is actually rehearsed before production tenant data/writes.

## Release / value gates

### BUILDER STAGE 1 — COMPLETE

Proven:
- one worker / one verified task loop;
- exact candidate / GitHub / CI evidence;
- deterministic verifier;
- Codex review;
- bounded retry/recovery;
- real AgencyOS task with zero routine owner relay.

Keep as regression suite. Do not reopen it as the active build phase.

### V1.0A — READ-SAFE FOUNDATION — CURRENT FIRST GATE

Build/reconcile:
- SOT sync guard;
- owner/auth skeleton sufficient for read access;
- tenants/users/memberships;
- Postgres connection/migrations;
- RLS/FORCE RLS + trusted transaction-local tenant context;
- canonical IDs/contract metadata;
- canonical events + corrected inbound authenticity boundary;
- current state/evidence/source health;
- capability/connector registry;
- read-only connector adapters;
- privacy/confidentiality enforcement for real tenant reads;
- observability/reconciliation for read paths.

**Done when:** tenant isolation, inbound authenticity, read provenance/freshness and privacy tests pass on current `main` lineage.

No external business writes.

### V1.0B — AGENT 0 T0/T1 EARLY VALUE

As soon as V1.0A passes, enable:
- Agent 0 T0 observe;
- Agent 0 T1 recommend/draft;
- Jarvis owner query/briefing over evidence-backed read state;
- first-party portfolio synthesis under confidentiality rules.

This may proceed while V1.0C is still being completed.

### V1.0C — WRITE-SAFE FOUNDATION

Build:
- active grants/caps/policy;
- exact approval/session/state binding;
- kill/revocation epochs;
- trusted executor;
- deterministic idempotency;
- postcondition verification;
- execution receipts;
- ambiguous-effect handling;
- single-flight semantics;
- write-path reconciliation;
- privacy/deletion for effect evidence.

No routine T2/T3/T4 is enabled merely because these components exist.

### V1.0D — DURABLE WORKFLOW ONLY WHEN JUSTIFIED

Adopt DBOS + separated schema/role when the selected workflow actually needs durable waits/retries/queues/signals/human waits.

DBOS is not a blocker for V1.0A/B.

### V1.1 — FIRST BOUNDED T2

Select one low-risk reversible/pre-authorized routine.

Run full write-path staging/shadow tests, including ambiguity/retry/recovery.

Enable only that exact routine if PASS.

### Later

- wider T2/T3 by measured trust;
- bounded specialists/parallel business workflows;
- Hermes/voice UX;
- Obsidian human knowledge layer;
- Prime/evals/optimization;
- advanced offer/behavioral intelligence;
- reseller UI.

## Deliberately not required before read-only value

- customer-facing autonomous T3/T4;
- free specialist swarm;
- Prime/RL;
- learned model router;
- second vector DB;
- Kafka/Kubernetes/Redis/Temporal for appearance;
- full reseller UI;
- broad computer-use automation;
- DBOS where no durable workflow need exists.

## Fast implementation sequence from current `main`

1. Sync this revised SOT + manifest to Project Sources and `docs/master-sot/` in a dedicated commit.
2. Ask Builder Core to diff `phase-1/secure-core-spine` against current `main` and produce `REUSE / REBUILD / DROP` classification with no writes first.
3. Create one fresh Secure Core integration branch from current `main`; do **not** merge the old branch wholesale.
4. Reuse/cherry-pick only compatible migrations/tests/modules and re-run them under current CI/verifier/Codex.
5. One primary schema writer owns base migrations/RLS/event contracts until V1.0A contracts are stable.
6. In parallel, allow non-mutating work: adversarial test design, Codex review, connector scope/resource discovery, documentation and evidence preparation.
7. Once base contracts are stable, use up to 2–3 isolated coding workers for disjoint modules with explicit path/resource ownership.
8. Finish V1.0A read-safe gates.
9. Immediately enable/develop Agent 0 T0/T1 and read-only owner briefings.
10. Continue V1.0C write-safe slices in parallel where dependencies permit.
11. Add DBOS only when a selected durable workflow needs it; prove its recovery semantics before relying on it.
12. Select one low-risk T2 routine and run its complete write-path acceptance suite.
13. Enable only that exact T2 routine after PASS.

## Parallelism guardrail

Speed comes from **dependency-aware concurrency**, not a swarm.

Before running multiple coding workers, Builder Core must define:
- task dependency DAG;
- allowed paths/resources per worker;
- one writer for shared migrations/schema;
- isolated branches/worktrees;
- fresh exact-SHA verification after integration.
