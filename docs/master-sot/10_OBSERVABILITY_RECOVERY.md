# 10 — OBSERVABILITY & RECOVERY

## Four separate systems

1. Receipts — prove material effects.
2. Traces — explain execution.
3. Health — show degraded infrastructure/providers.
4. Reconciliation — tests whether AgencyOS state still matches external reality.

## Truth states

`HEALTHY`
`DEGRADED`
`STALE`
`CONFLICTED`
`UNKNOWN`
`BLOCKED`

Never fabricate a numeric health confidence.

## Source/event health

Track:
- authentication verification,
- delivery/dedupe,
- freshness,
- reconciliation cursor,
- outage/suspension,
- last successful authoritative read.

Forged/unverified inbound event cannot become canonical truth.

## Materiality / false-negative protection

Deterministic policy marks security, authority, credential, material financial, privacy/legal, unknown-effect and control-store outage classes as non-silenceable.

An LLM may increase urgency or summarize context.
It may not hide a non-silenceable event.

## Briefing integrity

Every factual owner claim must resolve to evidence/current-state refs.

Untrusted-origin text is attributed.

Approval actions are rendered separately from briefing prose and bind to exact proposal/request hash.

## Reconciliation

Reconciliation may:
- safely repair projections when no local pending effect exists;
- mark STALE/UNKNOWN;
- mark CONFLICTED.

It may not auto-clobber a local pending/ambiguous effect.

## Recovery

`DETECT`
→ classify
→ contain
→ retry/refresh/reconcile/compensate/escalate
→ verify
→ close.

Never blindly retry an unknown non-idempotent external effect.

## PITR / idempotency

After restore:
- freeze all writers;
- bump recovery/kill epoch;
- restore Postgres;
- rebuild derived indexes;
- restore/reconcile DBOS workflow state;
- re-evaluate pending/ambiguous external steps using deterministic idempotency keys and postcondition checks;
- reconcile providers;
- only then re-enable writes.

PITR must not create a new logical idempotency key for an already-committed external effect.

## Authority-store outage

If fresh authority/kill state cannot be read:
- privileged/material writes fail closed;
- owner sees DEGRADED/BLOCKED;
- read-only observation may continue with explicit freshness labels.

## Backups

Required:
- Postgres PITR/continuous recovery;
- object-storage versioning/retention;
- Git remote;
- rebuildable pgvector/FTS.

Backup is not proven until restore is tested.

## Metrics

Track at minimum:
- owner interruption precision;
- avoidable interruption rate;
- material event miss rate;
- event compression ratio;
- unchanged-state repeat notifications;
- evidence coverage;
- freshness compliance;
- reconciliation drift rate;
- duplicate-effect rate;
- ambiguous-effect rate;
- policy/kill fail-closed events;
- cross-tenant security test failures;
- cost per verified successful outcome.
