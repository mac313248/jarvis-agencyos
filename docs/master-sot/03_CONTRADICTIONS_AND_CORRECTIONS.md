# 03 — CONTRADICTIONS & CORRECTIONS

## Final cross-pass resolutions

| Tension | Resolution |
|---|---|
| Jarvis “boss” wording vs deterministic authority | one Jarvis owner experience; Jarvis Interface mediates, Builder Core owns software-work authority, AgencyOS Business Core owns business authority |
| Build Secure Core first vs build Builder first | different stages: thin Builder first, then immediately use it to build Secure Core |
| Global Jarvis vs tenant isolation | first-party portfolio synthesis only; third-party tenants isolated; typed receipts, no global raw memory |
| Postgres vs provider SOT | provider authoritative for external object; Postgres canonical internal normalized state with provenance/reconciliation |
| Git policy vs active authority | Git owns policy definitions; Postgres owns active grants/caps/decisions |
| Hermes memory vs Postgres | Hermes hot/runtime memory only |
| Specialists vs default one agent | specialists available, never mandatory |
| One worker vs speed | Stage 1 used one worker; after Stage 1, bounded parallelism is allowed only for disjoint dependency-ready tasks |
| Reviewer vs tests | deterministic verification first; semantic review additive |
| MCP vs authority | interoperability only; AgencyOS policy is authority |
| DBOS vs external exactly-once | DBOS internal durability when justified; AgencyOS idempotency/postcondition for external effects |
| DBOS everywhere vs speed | Postgres is required; DBOS does not block simple/read-only paths and is introduced when workflow semantics justify it |
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
Unverified/failed-auth external events cannot materialize canonical state.

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

## Live Builder Stage-1 corrections now incorporated

### Builder-first sequencing
The reconciliation's Builder-first decision is now proven in reality. Stage 1 completed and was merged before continuing Secure Core.

### Trusted-internal provenance
The real AgencyOS inbound-auth task exposed an important gap:

- external or unknown/unclassified events fail closed unless trusted infrastructure verifies authenticity;
- `NOT_APPLICABLE` cannot be a generic passthrough;
- only a positively established trusted-internal event path may use `NOT_APPLICABLE`;
- caller-supplied `connector`, `verification`, `trusted`, `internal`, event type, or equivalent metadata cannot establish that provenance.

### Secret handling
A live credential exposure during Builder diagnostics proved that secrets must be centrally redacted at provider/store/trajectory/error boundaries. Raw secrets may never appear in logs, errors, serialized provider state, or trajectory evidence.

### Evidence binding
Review/test evidence must bind to the exact implementation SHA/candidate. Evidence generated for an earlier head cannot authorize a changed head.

### Model/provider capacity
Reviewer capacity failures are infrastructure failures, not grounds to bypass review. A bounded same-provider alternate-model fallback is allowed only for explicit capacity/unavailable-model conditions and must preserve immutable review input.

## Documentation normalization

`06_SYSTEM_CONTRACTS.md` is the sole canonical AgencyOS business-runtime schema/contract source.

Builder Core Stage-1 schemas remain frozen in implemented code/evidence and are not duplicated here.
