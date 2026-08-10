# 03 — CONTRADICTIONS & CORRECTIONS

## Final cross-pass resolutions

| Tension | Resolution |
|---|---|
| Global Jarvis vs tenant isolation | First-party portfolio synthesis only; third-party tenants isolated; typed receipts, no global raw memory |
| Postgres vs provider SOT | provider authoritative for external object; Postgres canonical internal normalized state with provenance/reconciliation |
| Git policy vs active authority | Git owns policy definitions; Postgres owns active grants/caps/decisions |
| Hermes memory vs Postgres | Hermes hot/runtime memory only |
| Specialists vs default one agent | specialists available, never mandatory |
| Reviewer vs tests | deterministic verification first |
| MCP vs authority | interoperability only; AgencyOS policy is authority |
| DBOS vs external exactly-once | DBOS internal durability; AgencyOS idempotency/postcondition for external effects |
| Browser/Orgo vs security | fallback surface cannot bypass executor/policy |
| Agent 0 persistence | persistent logical identity/state, not persistent inference |
| Learning vs self-learning | governed promotion only |
| OTel vs truth | traces explain; receipts/state establish truth |

## Independent-audit corrections applied

### Tenant isolation
Changed from a principle-only “hard tenant boundary” to an enforceable V1 lock:
Postgres RLS + FORCE RLS + trusted transaction-local context + least-privilege runtime roles.

### Owner briefing injection
Untrusted-origin content remains attributed/quoted and cannot become trusted owner narrative.
`APPROVE/REJECT` binds to exact proposal/request, not prose.

### Inbound authenticity
Unverified/failed-auth webhook events cannot materialize canonical state.

### Idempotency / PITR
Idempotency key derivation is deterministic from stable workflow/step/request identity.
Providers lacking idempotency + observable postcondition cannot be autonomously replayed after ambiguity/restore.

### Agent 0 concurrency
Customer-facing decision cycles are single-flight by tenant + subject + routine.

### Cross-surface fallback
Ambiguous first attempt must be proven absent before weaker fallback.

### Owner root of trust
V1 requires authenticated owner session + step-up MFA for high-risk approvals.

### PII deletion
Raw identifiable PII is not placed into immutable audit proofs.
Deletion propagates to canonical and derived surfaces.

### Kill/revocation TOCTOU
Executor revalidates revocation/kill epoch immediately before commit and records the epoch used.

### Fail closed
Authority/kill-store unavailability blocks material writes.

### Reconciliation
Pending local effect/receipt cannot be blindly overwritten as drift; becomes CONFLICTED.

## Documentation normalization

`06_SYSTEM_CONTRACTS.md` is the sole canonical schema/contract source.

Other files must not maintain competing copies of contract schemas.
