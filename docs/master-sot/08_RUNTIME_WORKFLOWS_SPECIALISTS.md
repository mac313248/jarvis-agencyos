# 08 — RUNTIME, WORKFLOWS & SPECIALISTS

## Specialists / concurrency

Available specialist contracts remain:

**Scout** — discovers information/evidence.  
**Analyst** — reasons over structured evidence.  
**Builder** — creates software/assets/configuration.  
**Operator** — performs governed operational tasks.  
**Reviewer** — independent verification when required.

Default execution remains:

`ONE AGENT`
→ solve if adequate
→ delegate only if justified.

Stage 1 intentionally proved the sequential loop first.

After Stage 1, **bounded parallelism is allowed when it buys real speed**:
- maximum 2–3 coding workers initially;
- tasks must be dependency-ready and disjoint;
- isolated branches/worktrees;
- one primary writer for any shared migration/schema/resource;
- deterministic dependency DAG;
- stale-base detection and fresh verification before integration;
- no free-form swarm or peer-negotiated authority.

No:
- permanent department swarm;
- recursive autonomous hierarchy;
- unrestricted peer chat;
- agents negotiating authority;
- agent-created specialists with new permissions;
- concurrent writers to the same security-critical file/migration set without explicit serialization.

## Coding factory — live status

Builder Stage 1 is **PROVEN and merged**.

Current architecture:

`AgencyOS task envelope`
→ Builder Core
→ Cursor / other qualified native coding runtime
→ isolated branch/worktree/environment
→ implementation
→ tests
→ PR
→ GitHub CI
→ deterministic verification
→ Codex semantic review when policy requires
→ merge authorization.

AgencyOS custom software-factory code remains limited to the thin control surface already proven:
- task/spec envelope;
- provider launch/status/cancel;
- run/PR registry;
- acceptance/gate reader;
- bounded repair;
- evidence/trajectory linkage.

Do not rebuild a VM platform, generalized scheduler, or giant custom coding runtime unless measured need proves it.

## Durable workflows

**Postgres is the AgencyOS business-state foundation.**

DBOS is the approved V1 durable-workflow engine **when the workflow requires it** — for example:
- long waits;
- durable retries;
- queues;
- signals;
- human approval waits;
- crash-resumable multi-step routines.

DBOS is **not** a prerequisite for:
- Builder Core;
- simple request/response operations;
- read-only connector syncs that can be safely reconciled without workflow state;
- early Agent 0 T0/T1 observation/recommendation.

When DBOS is used, every nondeterministic LLM call, tool call or external interaction inside a durable process becomes a durable step.

DBOS owns:
- workflow execution;
- waiting;
- retries;
- queues;
- signals;
- checkpoint/recovery.

AgencyOS owns:
- product state;
- authority;
- external-write idempotency;
- external verification;
- business receipts.

DBOS does **not** make external side effects exactly once. External writes still require deterministic idempotency and/or postcondition verification.

Temporal/Restate remain later escalation options only if actual scale/distribution requirements justify them.

## Fast Secure Core execution pattern

Build in dependency waves rather than one giant serial project:

1. **Reconcile prior `phase-1/secure-core-spine` work against current `main`.**
2. **Read-safe foundation:** tenant/RLS, canonical events/authenticity, state/evidence, connector registry, read-only access.
3. **Begin Agent 0 T0/T1 as soon as read-path security gates pass.**
4. **Write-safe foundation in parallelizable slices:** authority/approvals; executor/receipts/idempotency; kill/revocation/reconciliation.
5. **Adopt DBOS only when the first selected durable business routine requires it.**
6. **Enable only the exact low-risk T2 routine whose write-path tests pass.**
