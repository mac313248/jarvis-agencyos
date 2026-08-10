# 01 — ARCHITECTURE LOCKS

## Jarvis

Jarvis is the owner-facing Chief of Staff and mediation layer.

Jarvis:
- understands owner intent;
- gathers constrained state;
- briefs and prioritizes;
- allocates work;
- requests explicit approvals;
- coordinates Agent 0 and bounded specialists;
- explains evidence, uncertainty, conflicts and health.

Jarvis does **not** own:
- raw business truth;
- credentials;
- production authority;
- tenant data;
- workflow durability;
- continuous cognition.

**The infrastructure stays aware. Jarvis wakes when judgment is useful.**

## Agent 0

Agent 0 is the tenant-bound logical business operator.

Each business tenant has one logical Agent 0 identity.

It is instantiated from durable tenant state when work arrives and cannot grant itself authority.

## Hard tenant isolation — normative

`tenant_id` is a non-bypassable security/data/execution/authority boundary.

### Primary enforcement

V1 MUST use **PostgreSQL Row-Level Security** on every tenant-owned table, with:
- RLS enabled;
- `FORCE ROW LEVEL SECURITY` where applicable;
- runtime DB roles that are not superusers, not table owners, and do not have `BYPASSRLS`;
- transaction-local tenant context set by trusted server infrastructure;
- tenant-aware relational constraints/foreign keys where applicable.

Application-layer filtering is **defense in depth only** and MUST NOT be the sole tenant boundary.

### Runtime rule

The model/client cannot choose or override `tenant_id`.

Tenant scope is created by trusted infrastructure and carried through:
- tasks,
- workflows,
- workers,
- retrieval,
- connectors,
- credentials,
- events,
- receipts,
- approvals,
- Agent 0 routines.

## Confidentiality model

Tenants are classified at minimum as:

- `FIRST_PARTY_PORTFOLIO`
- `THIRD_PARTY_ISOLATED`

The owner may intentionally synthesize across authorized `FIRST_PARTY_PORTFOLIO` tenants.

A `THIRD_PARTY_ISOLATED` tenant:
- is processed tenant-locally;
- does not influence another tenant's customer-facing output or decision context;
- does not contribute raw data to global durable memory;
- may contribute only explicitly permitted, de-identified aggregate operational metadata.

## Cross-business owner view

`owner request`
→ resolve authorized first-party portfolio
→ independent tenant-bound fan-out
→ typed tenant receipts
→ global synthesis.

Raw tenant context is not persisted globally.

## Authority

Permanent rule:

> **Owner grants authority. Jarvis allocates already-granted authority to work. Workers use it. Policy limits it. Trusted executors enforce it.**

“Allocates” means attenuation/routing of an existing valid grant. Jarvis cannot mint, widen or reactivate authority.

Natural language cannot create or expand authority.

## Owner authentication

Owner identity is part of the root of trust.

V1 requires:
- authenticated owner session;
- MFA enrollment;
- short-lived step-up MFA for high-risk grants/approvals;
- exact proposal-bound approval;
- session revocation/logout;
- secure account recovery.

High-risk approval in V1 = **owner + step-up MFA**.

No mandatory two-human approval in V1.

## Memory / state / truth

- External provider = authority for its own external object.
- Postgres = canonical AgencyOS normalized dynamic state + decisions + provenance + projections.
- Git/GitHub = canonical versioned procedures/skills/policies/prompts/tests.
- Object storage = raw evidence.
- DBOS = V1 durable workflow execution state.
- pgvector/FTS = rebuildable retrieval indexes.
- Hermes = replaceable conversation/runtime + tiny hot memory.
- Obsidian = optional human knowledge surface.

Conversation history, summaries and vector similarity are evidence/context — not authority.

## Events / proactivity

`authenticated webhook / stream / poll / reconciliation`
→ normalize
→ dedupe
→ materialize state
→ freshness/conflict
→ materiality
→ `SILENCE | BATCH | NOTIFY | WAKE`.

Unauthenticated or failed-auth inbound events cannot materialize canonical state.

## Non-silenceable classes

These classes cannot be reduced to SILENCE by an LLM/materiality heuristic:

- tenant-isolation/security event;
- credential/authentication anomaly;
- authority/permission change;
- kill-switch/fail-closed event;
- material spend/refund/discount/price/commitment event;
- opt-out/legal/privacy request;
- customer-facing effect with unknown/ambiguous result;
- provider/control-store outage affecting safe execution;
- verified severe production fault.

They must at least enter owner-visible attention state, with notification severity determined by deterministic policy.

## Specialists

Default = one agent.

V1 specialist contracts:
- Scout
- Analyst
- Builder
- Operator
- Reviewer

Specialists are available capabilities, not mandatory pipeline stages.

No:
- permanent swarm;
- free recursive delegation;
- unrestricted peer chat;
- runtime-created privileged specialist types;
- uncontrolled parallel writers.

## Tools / hands

Preferred execution surface:

1. direct API/SDK;
2. approved API-backed MCP/Hermes tool;
3. structured CLI/code;
4. deterministic DOM/browser automation;
5. model-driven browser automation;
6. full computer use / Orgo;
7. human.

A weaker fallback cannot be used after an ambiguous write unless the first effect is proven absent.

## Trusted executor

All material external effects pass through the trusted executor.

No verified receipt = no claim that a material action succeeded.

## V1 durability

DBOS + Postgres.

Internal workflow durability does not create exactly-once external side effects.

External effects require deterministic idempotency and/or observable postcondition verification.

## Fail-closed rule

If authority/kill-state cannot be freshly verified, material writes are denied.

Control-plane degradation never causes fail-open execution.

## Coding factory

Use Cursor as primary builder and Codex as independent reviewer/fallback.

Use native execution runtimes and GitHub gates rather than building a giant custom coding-agent runtime.

## Mac Mini

The Mac Mini remains the trusted owner build/control host.

The durable product truth is still in Git/Postgres, not in the Mac Mini filesystem alone.

Cloud coding workers may execute remotely, but all work is governed by this SOT and the Git repository.
