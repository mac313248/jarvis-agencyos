# 04 — LIVE VERIFICATION BACKLOG

Architecture is frozen. This file distinguishes **proven live evidence** from the **current Secure Core backlog**.

## Proven by Builder Stage 1

- private `mac313248/jarvis-agencyos` repository and Mac Mini clone in active use;
- Cursor primary builder authentication and lifecycle;
- provider run ↔ factory run mapping;
- exact branch / commit SHA / draft PR / CI binding;
- independent deterministic verification;
- independent Codex review with bounded capacity fallback;
- worker crash/failure handling, stale-run fencing and bounded retry;
- restart/recovery state reconstruction;
- secret redaction at Builder boundaries;
- protected acceptance / worker self-certification rejection;
- one real AgencyOS inbound-authenticity task completed with zero routine owner AI-to-AI relay;
- reviewed Builder Stage-1 freeze merged to `main`.

These remain regression requirements.

## Immediate Secure Core acceleration item

A prior unmerged branch, `phase-1/secure-core-spine`, contains useful candidate work from before the Builder-first pivot, including migrations for RLS/tenant context, owner auth, authority, events/state/evidence, receipts/PII refs and kill epochs.

**Required:** reconcile it against current `main`; reuse/cherry-pick compatible work; do not blind-merge the old branch.

Earlier evidence is useful input, not current-main PASS. All retained code must be re-run through current tests/CI/Codex.

## Postgres / tenant boundary — OPEN

- reproduce migrations on current `main`;
- run RLS/FORCE RLS attack battery;
- runtime role has no `BYPASSRLS`, is not table owner/superuser;
- pooled transaction-local tenant context cannot leak;
- missing/invalid tenant context fails closed;
- cross-tenant FK/constraint tests;
- first real multi-process PostgreSQL run, not only PGlite;
- PITR restore rehearsal before production data;
- authority-store outage fail-closed test;
- DBOS schema/role separation **if/when DBOS is adopted**.

## Inbound events — OPEN / HIGH PRIORITY

For every external provider path:
- signature/auth verification;
- replay/dedupe;
- spoofed-event rejection;
- unknown/unclassified event fails closed;
- caller-supplied trust/internal/verification fields cannot establish provenance;
- trusted-internal bypass requires non-forgeable trusted-infrastructure provenance;
- source outage/reconciliation.

The generic invariant was proven by the Stage-1 real task; each live provider still needs provider-specific verification.

## Owner authentication — OPEN

- real MFA enrollment;
- step-up flow;
- approval binding to proposal/request hash + exact owner session/principal;
- payload/state mutation invalidates approval;
- session revocation/recovery.

## Authority / executor / effects — OPEN

- active grant/cap evaluation;
- revocation + kill epoch re-read immediately before commit;
- authority/kill-store outage fails closed;
- deterministic idempotency survives restart/restore;
- duplicate logical effect executes at most once;
- ambiguous external effect never blindly retries;
- postcondition verification;
- execution receipt binds exact request, authority and outcome.

## DBOS — CONDITIONAL

Do not install DBOS merely because it is in the architecture.

Adopt it when the selected business workflow actually needs durable waits/retries/queues/signals/human waits, then test:
- crash/recovery;
- waits/approval persistence;
- deterministic workflow ID behavior;
- PITR/recovery interaction;
- external ambiguous side-effect recovery.

## Read-only connectors — CAN RUN IN PARALLEL AFTER BASE TENANT/CONNECTOR CONTRACTS

- GHL exact scopes, resources, webhook coverage and read mappings;
- Meta resource bindings, reporting latency and read mappings;
- Google/Gmail push/history recovery;
- ClickUp workspace binding and reconciliation;
- GitHub App permissions/protected branch enforcement;
- payment-provider read-only truth surface and future idempotency/preconditions.

Start with reads. Do not let connector work invent business authority.

## Hermes / Orgo

- Hermes tool inheritance/security boundaries;
- Orgo credential/egress/restart behavior;
- computer-use fallback cannot bypass executor.

Not a blocker for Secure Core read-safe foundation.

## Privacy/deletion — OPEN BEFORE OUTSIDE CUSTOMER DATA

- data-subject delete removes canonical PII, evidence copies, vectors, FTS, caches and derived summaries;
- non-identifying audit tombstone remains;
- third-party tenant A content cannot influence tenant B output.

## Business policy still requiring owner thresholds

- exact spend caps;
- refund/discount limits;
- customer-commitment limits;
- T2/T3/T4 envelopes;
- retention/legal holds where applicable.

These do not block T0/T1 read-only observation/recommendation unless the specific workflow requires the missing decision.
