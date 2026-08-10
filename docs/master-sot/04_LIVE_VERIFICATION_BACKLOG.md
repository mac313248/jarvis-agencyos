# 04 — LIVE VERIFICATION BACKLOG

Architecture is frozen. These are live tests/configuration items.

## Mac Mini / repo
- verify clean private GitHub repo;
- verify local clone path and permissions;
- verify Cursor primary builder access;
- verify Codex reviewer/fallback access;
- verify SOT manifest hashes match the ChatGPT Project copy.

## Postgres
- RLS/FORCE RLS attack battery;
- runtime role has no `BYPASSRLS`, is not table owner/superuser;
- pooled transaction-local tenant context cannot leak;
- cross-tenant FK/constraint tests;
- PITR restore rehearsal;
- authority-store outage fail-closed test;
- DBOS schema/role separation.

## DBOS
- crash/recovery;
- waits/approval persistence;
- deterministic workflow ID behavior;
- PITR/recovery interaction;
- external ambiguous side-effect recovery.

## Owner authentication
- MFA enrollment;
- step-up flow;
- approval binding to proposal/request hash;
- session revocation/recovery.

## Inbound events
For each provider:
- signature/auth verification;
- replay/dedupe;
- spoofed-event rejection;
- source outage/reconciliation.

## Connectors
- GHL exact scopes, iMessage path, webhook coverage, workflow/funnel write surface;
- Meta resource bindings and reporting latency;
- Google/Gmail push/history recovery;
- ClickUp workspace binding and reconciliation;
- GitHub App permissions/protected branch enforcement;
- payment-provider idempotency/preconditions.

## Hermes / Orgo / Cursor
- Hermes tool inheritance/security boundaries;
- Orgo credential/egress/restart behavior;
- Cursor branch/run/cancel/SSE/secret behavior;
- computer-use fallback cannot bypass executor.

## Privacy/deletion
- data-subject delete removes canonical PII, evidence copies, vectors, FTS, caches and derived summaries;
- non-identifying audit tombstone remains;
- third-party tenant A content cannot influence tenant B output.

## Business policy still requiring owner thresholds
- exact spend caps;
- refund/discount limits;
- customer-commitment limits;
- T2/T3/T4 envelopes;
- retention/legal holds where applicable.

These tests may change provider/configuration choices. They do not reopen architecture unless the required contract proves impossible.
