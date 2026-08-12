# 02 — RESEARCH DECISION LEDGER

| Decision | Final lock | Status |
|---|---|---|
| Jarvis role | Owner-facing Chief of Staff/mediator; not the business authority store | LOCKED |
| Trust domains | Jarvis Interface, Builder Core, AgencyOS Business Core remain logically separate | LOCKED AFTER RECONCILIATION |
| Build order | Thin Builder first; immediately use it to build AgencyOS Secure Core | PROVEN / LOCKED |
| Builder Stage 1 | Cursor worker + exact candidate + CI + deterministic verifier + Codex + recovery; one real AgencyOS task with zero routine owner relay | PROVEN |
| Authority | Owner grants; Jarvis routes/attenuates; deterministic policy/executor enforce | LOCKED |
| Tenancy | Postgres RLS + trusted transaction-local tenant context; app filters only defense-in-depth | LOCKED AFTER AUDIT |
| Cross-business privacy | Owner first-party businesses may be synthesized; third-party tenants isolated | OWNER LOCKED |
| Owner high-risk approval | Owner + step-up MFA; no mandatory two-person approval V1 | OWNER LOCKED |
| Customer deletion | Delete identifiable data from canonical + derived surfaces; retain non-identifying audit proof | OWNER LOCKED |
| Background awareness | Event/state/reconciliation layer; Jarvis wakes only when useful | LOCKED |
| Memory | Postgres/Git/evidence/workflow layered model | LOCKED |
| Delegation | Default one agent; bounded specialists only when justified | LOCKED |
| Coding parallelism | After Stage 1, 2–3 workers are allowed only for dependency-ready, disjoint work with isolated branches/worktrees and one writer per shared resource | LOCKED |
| Tools | structured API first; Orgo/browser fallback | LOCKED |
| Inbound external/unknown events | must be authenticated/verified by trusted infrastructure before canonical materialization | LOCKED + LIVE PROVEN |
| Trusted internal events | bypass external auth only through non-forgeable trusted-infrastructure provenance; caller claims cannot establish trust | LOCKED AFTER LIVE STAGE-1 FINDING |
| Approvals | bind to exact proposal + canonical request hash + authenticated owner session | LOCKED AFTER AUDIT |
| Idempotency | deterministic key from stable workflow/step/capability/request identity | LOCKED AFTER AUDIT |
| Ambiguous external effect | verify absence before weaker fallback/retry; otherwise human/blocked | LOCKED AFTER AUDIT |
| Agent 0 concurrency | per-tenant+subject+routine single-flight for customer-facing decisioning | LOCKED AFTER AUDIT |
| Materiality | defined security/financial/privacy/fault classes are non-silenceable | LOCKED AFTER AUDIT |
| Authority store outage | material writes fail closed | LOCKED AFTER AUDIT |
| Reconciliation | pending local effect/receipt prevents blind provider overwrite; mark CONFLICTED | LOCKED AFTER AUDIT |
| PII/audit | immutable/audit records must avoid raw deletable PII; use opaque subject refs | LOCKED AFTER AUDIT |
| Workflow storage | Postgres business state; DBOS workflow state separated by schema/role when DBOS is used | LOCKED |
| DBOS adoption | use when durable waits/retries/queues/signals materially justify it; do not block read-only T0/T1 on DBOS | LOCKED AFTER RECONCILIATION |
| Coding | `mac313248/jarvis-agencyos`; Cursor primary builder; Codex reviewer/fallback; Mac Mini control host | LIVE PROVEN |
| Current phase | AgencyOS Secure Core; business-write autonomy remains disabled | CURRENT |

## Reopen rule

Only reopen a frozen architecture decision if live evidence proves the contract cannot be implemented safely.

Provider/library preference changes do not reopen architecture.
