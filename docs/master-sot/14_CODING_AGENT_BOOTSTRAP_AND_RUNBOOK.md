# 14 — CODING AGENT RUNBOOK — CURRENT SECURE CORE PHASE

## Current state

Builder Stage 1 is complete, frozen and merged to `main`.

Current repository:
- private repo: `mac313248/jarvis-agencyos`;
- control/build host: Mac Mini;
- primary builder: Cursor through Builder Core;
- independent reviewer: Codex;
- business-write autonomy: **DISABLED**.

The owner should no longer manually act as the normal AI-to-AI courier. Use the proven Builder path for AgencyOS implementation tasks.

## How the ChatGPT Master SOT matches the Mac Mini

There are two copies of the same approved SOT:

1. **ChatGPT Project Sources** — human/control reference.
2. **Git repository `docs/master-sot/`** — exact machine-readable mirror.

They match only when every canonical SOT file hash matches `SOT_SYNC_MANIFEST.sha256`.

The coding system must stop on mismatch.

## Repo SOT rule

Cursor/Codex may READ `docs/master-sot/`.

They MUST NOT rewrite architecture files because implementation is inconvenient.

If live evidence proves a genuine contradiction:
- use `WAITING_ON_ARCHITECTURE`;
- show concrete evidence;
- do not silently change SOT.

## Root `AGENTS.md` required direction

Keep it short and include:

```text
AUTHORITATIVE DESIGN:
Read docs/master-sot/00_START_HERE.md first.

Required before security/business-runtime work:
01_ARCHITECTURE_LOCKS.md
05_PRODUCT_BEHAVIOR.md
06_SYSTEM_CONTRACTS.md
07_AUTHORITY_SECURITY_EXECUTION.md
08_RUNTIME_WORKFLOWS_SPECIALISTS.md
10_OBSERVABILITY_RECOVERY.md
12_ACCEPTANCE_AND_IMPLEMENTATION.md
14_CODING_AGENT_BOOTSTRAP_AND_RUNBOOK.md

06_SYSTEM_CONTRACTS.md is the canonical AgencyOS business-runtime contract/schema source.
Never modify docs/master-sot silently.
Verify SOT_SYNC_MANIFEST.sha256 before work.

Primary builder: Cursor through Builder Core.
Independent reviewer: Codex.
No business-write autonomy until applicable write-path gates pass.
```

## Builder operating mode

For each material AgencyOS task, Builder Core should:
1. read/verify the SOT;
2. lock task intent + acceptance;
3. inspect relevant current repo state;
4. launch one primary worker per task;
5. use bounded research/tools only as needed;
6. implement;
7. run deterministic tests/CI;
8. repair bounded failures;
9. bind evidence to exact candidate SHA/PR;
10. obtain Codex review at security/phase gates;
11. continue automatically when PASS and no owner gate exists.

## Owner question policy

Do NOT ask the owner routine engineering questions such as:
- table names;
- library choices;
- UUID choices;
- ordinary schema implementation;
- test framework;
- retry library;
- file layout below frozen boundaries;
- reversible provider SDK details.

Stop only for:
- login/OAuth/MFA/access;
- production/staging credentials;
- exact business authority threshold;
- privacy/legal decision;
- product behavior ambiguity;
- genuinely irreversible choice;
- live platform limitation that materially breaks the SOT.

Use `WAITING_ON_OWNER` for pure access/login/MFA/key/account-selection steps.

## Git rules

- `main` stays protected;
- material work uses feature branches/PRs;
- exact candidate SHA is the unit of verification/review;
- Cursor is primary writer for a task;
- Codex is independent reviewer, not uncontrolled concurrent writer;
- SOT sync changes use dedicated commits;
- no blind merge of stale branches;
- production procedures pin exact Git SHA.

## CURRENT MISSION — AGENCYOS SECURE CORE

### Step 0 — sync this revised SOT

Before Secure Core implementation:
1. replace Project Sources with the revised synchronized package;
2. copy the identical package into `docs/master-sot/`;
3. verify the new manifest;
4. commit only the SOT synchronization change;
5. return to clean `main`.

### Step 1 — reclaim prior Secure Core work instead of rebuilding it blindly

There is useful prior candidate work on `phase-1/secure-core-spine`.

First Builder task is **read-only reconciliation**:

```text
Compare current main against phase-1/secure-core-spine.
Do not merge or modify code.
Produce a file/module/migration-level classification:
REUSE AS-IS
REUSE WITH REPAIR
REBUILD
DROP

Map every reusable item to current 06_SYSTEM_CONTRACTS.md and
12_ACCEPTANCE_AND_IMPLEMENTATION.md.
Explicitly include the new external/unknown-event fail-closed and sealed
trusted-internal provenance requirements.
Return the smallest ordered dependency plan for a fresh secure-core branch.
```

### Step 2 — create a fresh Secure Core branch from current `main`

Do not resurrect the old branch as the integration branch.

Suggested logical branch:

`phase-build/agencyos-secure-core`

Use old commits as source material only after reconciliation.

## Fast build strategy

### Wave A — Read-safe spine — one schema owner

One primary coding worker owns shared migrations/schema until these contracts stabilize:
- Postgres connection/migrations;
- tenant/user/membership model;
- RLS/FORCE RLS;
- trusted transaction-local tenant context;
- canonical IDs/version metadata;
- events/current state/evidence/source health;
- corrected inbound authenticity + sealed trusted-internal provenance;
- connector registry/read credential references;
- read-path privacy/confidentiality.

Run real multi-process PostgreSQL tests before declaring the DB boundary complete.

### What can run in parallel during Wave A

These can happen concurrently because they need not mutate the shared schema:
- Codex adversarial review;
- attack-test design;
- connector official-doc/resource/scope discovery;
- fixture creation;
- evidence/acceptance mapping;
- read-only adapter interface planning.

### Wave B — Early value

As soon as Read-Safe Foundation passes:
- build/enable Agent 0 T0 observation;
- build/enable Agent 0 T1 recommendations/drafts;
- Jarvis owner queries/briefings over evidence-backed read state;
- first-party portfolio synthesis where authorized.

Do **not** wait for business-write autonomy to get useful read-only Agent 0 value.

### Wave C — Write-safe spine — bounded parallel coding allowed

After base contracts/schema are stable, Builder may run up to 2–3 disjoint coding tasks simultaneously.

Example dependency-safe slices:

**Worker A — Authority / approvals**
- grants/caps;
- owner session + step-up binding;
- policy verdicts;
- revocation/kill state.

**Worker B — Executor / receipts / idempotency**
- exact proposal/capability execution envelope;
- deterministic idempotency;
- postcondition verification;
- execution receipts;
- ambiguity handling.

**Worker C — Read-only connectors / reconciliation**
- provider read adapters;
- provenance/freshness;
- resource ownership mapping;
- source reconciliation.

Guardrails:
- no two workers own the same migration/schema file at once;
- explicit allowed paths/resources;
- isolated branches/worktrees;
- dependency DAG;
- fresh CI/verifier/Codex after integration.

### Wave D — DBOS only when justified

Do not make DBOS a blocking installation task just because it is approved architecture.

Introduce DBOS when the first chosen business routine needs durable waits/retries/queues/signals/human waits.

Then prove:
- crash recovery;
- durable approval wait;
- stable workflow identity;
- PITR interaction;
- no duplicate external side effect.

### Wave E — first T2

Choose one low-risk reversible/pre-authorized business routine.

Pass the entire write-path acceptance suite in staging/shadow.

Enable only that exact routine.

## Speed rules

1. **Use Builder Core; do not manually relay AI context.**
2. **Reuse old code only through explicit reconciliation.**
3. **One schema owner first; parallelize after shared contracts are stable.**
4. **Run research/review/test-design concurrently with implementation.**
5. **Read-only connectors can start before write autonomy.**
6. **Agent 0 T0/T1 can start after read-safe gates; do not wait for T2.**
7. **DBOS is demand-driven, not calendar-driven.**
8. **No broad architecture research unless a live test contradicts the SOT.**
9. **Codex reviews phase/security boundaries; deterministic tests run continuously.**
10. **Never trade tenant isolation, authenticity, approval binding, idempotency or fail-closed behavior for speed.**

## Codex phase review prompt

```text
You are the independent reviewer for the current JARVIS / AGENCYOS Secure Core phase.

Read the relevant docs/master-sot files, especially:
01_ARCHITECTURE_LOCKS.md
06_SYSTEM_CONTRACTS.md
07_AUTHORITY_SECURITY_EXECUTION.md
12_ACCEPTANCE_AND_IMPLEMENTATION.md

Review the exact candidate diff, migrations, tests, test output and evidence.

Do not redesign for novelty.
Do not fail explicitly deferred later-wave items if the candidate does not claim them complete.

Return one verdict:
PASS
PASS WITH FIXES
or FAIL

Only report material:
- SOT contradiction;
- cross-tenant/RLS bypass;
- forgeable event authenticity/provenance;
- stale/forgeable approval;
- unsafe retry/idempotency;
- fail-open authority/kill behavior;
- missing required acceptance coverage;
- unsupported completion/evidence claim;
- recovery behavior that can duplicate/lose a material effect.
```

## Phase transition rule

A wave advances only when:
- required tests pass;
- evidence binds to exact candidate;
- Codex gate is PASS or required fixes are resolved;
- no owner/live gate remains.

Ordinary technical work then continues automatically.
