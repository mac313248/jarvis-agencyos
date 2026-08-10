# 14 — CODING AGENT BOOTSTRAP & RUNBOOK

## Owner choices

- Build the permanent AgencyOS/Jarvis foundation first.
- Primary builder: **Cursor**.
- Independent reviewer/fallback: **Codex**.
- Build/control host: **Mac Mini**.
- GitHub: **brand-new clean private repository**.

Recommended repository name: `jarvis-agencyos`.

Recommended Mac Mini path:

`$HOME/Projects/jarvis-agencyos`

## How the ChatGPT Master SOT matches the Mac Mini

There are two copies of the same approved SOT:

1. **ChatGPT Project**
   `JARVIS / AGENCYOS — MASTER (SOT)`
   - human/control reference;
   - owner decisions;
   - build-controller conversations.

2. **Git repository**
   `docs/master-sot/`
   - exact machine-readable mirror for Cursor/Codex;
   - committed to Git;
   - verified using `SOT_SYNC_MANIFEST.sha256`.

They are considered MATCHED only when every canonical SOT file hash matches the manifest.

The coding agent must stop on mismatch.

## Repo SOT rule

Cursor/Codex may READ `docs/master-sot/`.

They MUST NOT rewrite architecture files because implementation is inconvenient.

If implementation exposes a true architecture contradiction:
- mark `WAITING_ON_ARCHITECTURE`;
- show concrete live evidence;
- do not silently change SOT.

## Initial repository layout

```text
jarvis-agencyos/
├── AGENTS.md
├── README.md
├── docs/
│   └── master-sot/
│       ├── 00_START_HERE.md
│       ├── ...
│       ├── 14_CODING_AGENT_BOOTSTRAP_AND_RUNBOOK.md
│       └── SOT_SYNC_MANIFEST.sha256
├── src/
├── migrations/
├── tests/
├── scripts/
└── artifacts/
```

Exact application framework/layout below this level is a reversible engineering choice for the coding agent unless the SOT says otherwise.

## Root AGENTS.md — required content

The builder creates a SHORT `AGENTS.md` that says:

```text
# AGENTS.md

AUTHORITATIVE DESIGN:
Read docs/master-sot/00_START_HERE.md first.

Required before architecture/security work:
01_ARCHITECTURE_LOCKS.md
05_PRODUCT_BEHAVIOR.md
06_SYSTEM_CONTRACTS.md
07_AUTHORITY_SECURITY_EXECUTION.md
08_RUNTIME_WORKFLOWS_SPECIALISTS.md
10_OBSERVABILITY_RECOVERY.md
12_ACCEPTANCE_AND_IMPLEMENTATION.md
14_CODING_AGENT_BOOTSTRAP_AND_RUNBOOK.md

06_SYSTEM_CONTRACTS.md is the only canonical contract/schema source.

Never modify docs/master-sot silently.

Before work, verify:
sha256sum -c docs/master-sot/SOT_SYNC_MANIFEST.sha256

Primary builder: Cursor.
Independent reviewer/fallback: Codex.

Owner is nontechnical.
Do not ask routine engineering questions.
Ask only for:
- login/OAuth/MFA/access,
- product/business behavior,
- money/legal/privacy authority,
- genuinely irreversible choices.

No business-write autonomy until the applicable acceptance gates pass.
```

## Builder operating mode

Cursor should operate as the implementation worker.

It should:
1. read SOT;
2. verify hashes;
3. inspect the repo and live Mac Mini environment;
4. create an implementation plan for only the current phase;
5. create/lock tests before consequential behavior;
6. implement;
7. run tests;
8. repair failures;
9. produce evidence;
10. request Codex review at phase gate;
11. continue automatically if PASS and no owner gate exists.

## Codex role

Codex is:
- independent reviewer;
- contradiction detector;
- test/evidence reviewer;
- fallback implementation reviewer when Cursor is blocked.

Codex should not become a second uncontrolled writer to the same branch/resource.

Default review input:
- task/acceptance criteria;
- diff/artifact;
- test output;
- evidence;
- relevant SOT sections.

## Owner question policy

The coding system should NOT ask the owner:
- table names;
- library choices;
- UUID choices;
- ordinary schema implementation;
- test framework;
- retry library;
- file layout below frozen boundaries;
- reversible provider SDK details.

It MAY stop for:
- OAuth/login/MFA;
- production/staging credentials;
- exact business authority threshold;
- privacy/legal decision;
- product behavior ambiguity;
- live platform limitation that materially breaks SOT.

Ask at most 1–3 plain-English questions at a time.

## Human gate state

Use:

`WAITING_ON_OWNER`

not `BLOCKED`

when the only missing item is:
- login,
- OAuth,
- MFA,
- API key entry,
- account selection,
- screenshot confirmation.

After owner action, continue automatically.

## Git rules

- new repo is private;
- protected main before production build;
- feature branches/PRs for material work;
- Cursor is primary writer for a task;
- Codex is reviewer, not concurrent writer;
- required tests before merge;
- SOT sync changes happen in dedicated commits;
- production procedures pin Git SHA.

## Phase 1 bootstrap

The first implementation phase is the secure core spine:

- authentication skeleton;
- tenants/users/memberships;
- Postgres connection/migrations;
- RLS/FORCE RLS;
- transaction-local tenant context;
- canonical IDs;
- events/current state/evidence/receipts base tables;
- contract version metadata;
- DB roles/constraints;
- tenant isolation tests;
- SOT build binding.

No live business writes.

## MASTER CURSOR BOOTSTRAP PROMPT

Paste this once into Cursor Agent on the Mac Mini with the new repo open:

```text
You are the primary implementation agent for JARVIS / AGENCYOS.

Read docs/master-sot/00_START_HERE.md first.
Then read all files it marks required for implementation.

Before doing any design or code:
1. verify SOT_SYNC_MANIFEST.sha256;
2. inspect the current repo and Mac Mini environment;
3. confirm Git branch/status;
4. identify only the dependencies/access needed for V1.0 Foundation;
5. create a concise implementation plan for Phase 1;
6. map every Phase 1 change to acceptance tests from 12_ACCEPTANCE_AND_IMPLEMENTATION.md.

Rules:
- 06_SYSTEM_CONTRACTS.md is canonical for machine contracts.
- Do not change the SOT.
- Do not ask Alex routine technical questions.
- Choose safe reversible engineering defaults yourself.
- If login/OAuth/MFA/access is needed, enter WAITING_ON_OWNER and ask for only the exact action.
- No business-write autonomy.
- Postgres RLS is the primary tenant boundary; application filtering is defense-in-depth.
- Any privileged execution must fail closed if authority/kill state cannot be verified.
- Build incrementally, test continuously, repair your own failures.
- Use Git branches/commits carefully.
- Do not merge or claim PASS until required tests/evidence pass.
- At the Phase 1 gate, prepare a compact handoff for Codex review.

Start with inspection and Phase 1 planning. Do not jump to later phases.
```

## CODEX PHASE REVIEW PROMPT

```text
You are the independent reviewer for the current JARVIS / AGENCYOS implementation phase.

Read the relevant files under docs/master-sot/, especially:
01_ARCHITECTURE_LOCKS.md
06_SYSTEM_CONTRACTS.md
07_AUTHORITY_SECURITY_EXECUTION.md
12_ACCEPTANCE_AND_IMPLEMENTATION.md

Review the actual diff, migrations, tests and test output.

Do not redesign the architecture for novelty.

Return:
PASS
PASS WITH FIXES
or FAIL

Only report material:
- SOT contradiction,
- security/tenant flaw,
- missing acceptance coverage,
- unsafe retry/idempotency,
- unsupported completion claim,
- broken recovery,
- code that leaves a major architecture choice unstated.

If fixes are needed, give the smallest concrete fix list.
```

## Phase transition rule

A phase advances only when:
- required tests pass;
- evidence/artifacts exist;
- Codex gate is PASS or required fixes are resolved;
- no owner/live gate remains.

Then Cursor may continue to the next implementation phase without asking the owner to approve ordinary technical work.

## What “Phase 1 complete” means

Not “tables were created.”

It means:
- repo/SOT hashes match;
- migrations reproducible;
- RLS hard boundary proven with direct negative tests;
- runtime role cannot bypass isolation;
- tenant context cannot leak through pooling;
- base contracts exist/versioned;
- evidence/receipt/event/state primitives exist;
- no business writes enabled;
- test results recorded;
- Codex review passed.
