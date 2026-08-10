# 12 — ACCEPTANCE & IMPLEMENTATION

## Foundation authorization

Implementation may begin after this corrected SOT is synced to the new Git repository.

**Business-write autonomy remains disabled until write-path acceptance gates pass.**

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
11. `APPROVE` works only for exact `proposal_id + request_hash`.
12. Payload/state mutation invalidates prior approval.
13. Raw text “owner approved” has zero authorization value.
14. Revoked/expired grant blocks next action.

### Inbound authenticity
15. Forged/invalid-signature webhook cannot materialize canonical state.
16. Replay/duplicate creates one canonical event/state transition.
17. Authenticated payload text still remains untrusted for instruction purposes.

### Materiality
18. Security/credential/authority/material financial/privacy/fault classes cannot be SILENCED.
19. 10,000 healthy/no-op events produce zero unnecessary strong-model wakes.
20. Same unresolved state hash does not repeatedly notify.

### Idempotency / effects
21. Deterministic idempotency key is stable across restart.
22. Duplicate same logical effect executes at most once.
23. Crash after external commit but before local completion does not duplicate effect.
24. PITR restore does not resurrect an already-committed external effect.
25. Provider with no idempotency and no observable postcondition cannot auto-retry after ambiguity.
26. Ambiguous API/MCP write cannot fall back to browser/Orgo until negative postcondition is verified.
27. Successful external effect has verified receipt.
28. Unknown effect remains AMBIGUOUS/UNKNOWN, never silently SUCCEEDED.

### Agent 0 concurrency
29. Two simultaneous events for same tenant+subject+routine cannot create two customer-facing effects.
30. Cancelled/expired workflow cannot commit late effect.
31. semantic action dedupe prevents duplicate logical follow-up.

### Kill/revocation/fail closed
32. Revocation arriving between policy decision and commit blocks commit.
33. Receipt records commit-time revocation/kill epochs.
34. Authority/kill-store outage blocks material writes.
35. Zombie worker with stale epoch cannot commit.

### Reconciliation
36. Provider mismatch with no local pending effect safely repairs or escalates.
37. Pending/ambiguous local effect is never auto-overwritten as drift.
38. Stale source becomes STALE/UNKNOWN.
39. Conflicting authoritative evidence becomes CONFLICTED.

### Privacy / deletion
40. Valid customer deletion removes identifiable canonical data.
41. Embeddings/FTS/cache/derived summaries no longer expose deleted PII.
42. Immutable receipts contain no raw deletable PII when opaque subject ref suffices.
43. Non-identifying audit tombstone remains.
44. Third-party tenant data never becomes global raw durable memory.

### Coding
45. Cursor builder cannot merge failed CI.
46. Codex/reviewer cannot override valid deterministic test failure.
47. Protected main rejects unauthorized direct push.
48. build report records approved SOT manifest hash.
49. coding agent refuses to proceed if repo SOT hash mismatches approved manifest.

### Recovery
50. DBOS completed step survives restart without duplicate execution.
51. approval wait survives restart.
52. restore sequence freezes writers until Postgres/DBOS/providers reconcile.
53. backup restore is actually rehearsed.

## Release stages

### V1.0 FOUNDATION
Build only:
- new private Git repo;
- SOT sync guard;
- owner authentication/MFA skeleton;
- tenant/RLS model;
- Postgres state/evidence/receipts;
- authority/policy/kill;
- trusted executor;
- DBOS;
- canonical events + inbound authenticity;
- materialized state/freshness/reconciliation;
- capability/connector registry;
- read-only connector adapters;
- observability;
- backup/restore;
- security/privacy acceptance suite.

No business-write autonomy.

### V1.1 INTERNAL AGENT 0 PROOF
Add:
- Agent 0 T0/T1;
- one selected low-risk T2 routine only after write gates pass;
- Jarvis owner query/briefing;
- first-party business portfolio synthesis.

Goal: useful Agent 0 on the permanent foundation.

### V1.2 BOUNDED SPECIALISTS / CODING
Add only after foundation proves:
- bounded specialists where evals show benefit;
- native Cursor builder + Codex reviewer/fallback;
- GitHub PR/CI flow.

### V1.3 INTELLIGENCE FOUNDATIONS
Then add:
- behavioral event/features;
- offer hypothesis/experiment records.

This resolves the prior overly broad “V1” definition.

## Deliberately not built in V1.0
- customer-facing autonomous T3/T4;
- free specialist swarm;
- advanced offer/behavioral ML;
- Prime/RL;
- learned model router;
- second vector DB;
- Kafka/Kubernetes/Redis/Temporal for appearance;
- full reseller UI;
- broad computer-use automation.

## Implementation sequence

1. Create new private GitHub repo.
2. Clone on Mac Mini.
3. Copy exact corrected SOT to `docs/master-sot/`.
4. Verify `SOT_SYNC_MANIFEST.sha256`.
5. Create short root `AGENTS.md` pointing to SOT.
6. Reconcile actual Mac Mini/runtime environment.
7. Produce Phase 1 implementation plan + tests.
8. Build V1.0 Foundation in small verified phases.
9. Run all foundation/security tests.
10. Enable V1.1 T0/T1.
11. Select one T2 routine.
12. Run its write-path tests in staging/shadow.
13. Only then enable that exact T2 routine.
14. Add Jarvis briefing.
15. Add bounded specialists/coding integration later.
