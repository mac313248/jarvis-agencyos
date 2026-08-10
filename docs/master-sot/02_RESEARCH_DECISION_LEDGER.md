# 02 — RESEARCH DECISION LEDGER

| Decision | Final lock | Status |
|---|---|---|
| Jarvis role | Owner-facing Chief of Staff/mediator | LOCKED |
| Authority | Owner grants; Jarvis routes/attenuates; deterministic policy/executor enforce | LOCKED |
| Tenancy | Postgres RLS + trusted transaction-local tenant context; app filters only defense-in-depth | LOCKED AFTER AUDIT |
| Cross-business privacy | Owner first-party businesses may be synthesized; third-party tenants isolated | OWNER LOCKED |
| Owner high-risk approval | Owner + step-up MFA; no mandatory two-person approval V1 | OWNER LOCKED |
| Customer deletion | Delete identifiable data from canonical + derived surfaces; retain non-identifying audit proof | OWNER LOCKED |
| Background awareness | Event/state/reconciliation layer; Jarvis wakes only when useful | LOCKED |
| Memory | Postgres/Git/evidence/workflow layered model | LOCKED |
| Delegation | Default one agent; bounded specialists only when justified | LOCKED |
| Tools | structured API first; Orgo/browser fallback | LOCKED |
| Inbound events | must be authenticated/verified before canonical materialization | LOCKED AFTER AUDIT |
| Approvals | bind to exact proposal + canonical request hash + authenticated owner session | LOCKED AFTER AUDIT |
| Idempotency | deterministic key from stable workflow/step/capability/request identity | LOCKED AFTER AUDIT |
| Ambiguous external effect | verify absence before weaker fallback/retry; otherwise human/blocked | LOCKED AFTER AUDIT |
| Agent 0 concurrency | per-tenant+subject+routine single-flight for customer-facing decisioning | LOCKED AFTER AUDIT |
| Materiality | defined security/financial/privacy/fault classes are non-silenceable | LOCKED AFTER AUDIT |
| Authority store outage | material writes fail closed | LOCKED AFTER AUDIT |
| Reconciliation | pending local effect/receipt prevents blind provider overwrite; mark CONFLICTED | LOCKED AFTER AUDIT |
| PII/audit | immutable/audit records must avoid raw deletable PII; use opaque subject refs | LOCKED AFTER AUDIT |
| Workflow storage | DBOS system state logically separated by schema/role from tenant business data | LOCKED AFTER AUDIT |
| Coding | new private repo; Cursor primary builder; Codex reviewer/fallback; Mac Mini control host | OWNER LOCKED |

## Reopen rule

Only reopen a frozen architecture decision if live evidence proves the contract cannot be implemented safely.

Provider/library preference changes do not reopen architecture.
