# 13 — SOURCE INDEX

## Current evidence hierarchy

### 1. Frozen architecture/research basis

The August 10 Master SOT remains the architecture foundation after its audit corrections:
- deterministic authority outside models;
- Postgres RLS tenant isolation;
- exact approval binding;
- authenticated inbound events;
- deterministic idempotency + postcondition verification;
- fail-closed authority;
- provider-replaceable execution;
- governed learning.

### 2. Jarvis architecture reconciliation — controlling sequencing/boundary clarification

`JARVIS_ARCHITECTURE_RECONCILIATION_2026-08-10.md` resolved the important execution-order and naming issues:
- one Jarvis owner experience above separate logical trust domains;
- thin Builder first;
- immediately use Builder to build AgencyOS Secure Core;
- one worker before earned parallelism;
- DBOS not required for Builder Stage 1;
- business-runtime security remains mandatory before business data/writes.

### 3. Kamal founder-friendly roadmap/playbook — reference, not current status authority

`JARVIS_BUILD_PLAYBOOK_FOR_ALEX_2026-08-10.pdf` and `JARVIS_MASTER_ROADMAP_TREE_2026-08-10.pdf` remain useful explanatory artifacts.

They correctly preserve:
- build the builder first;
- worker never grades itself;
- failure/recovery proof;
- Hermes as interface, not authority;
- Obsidian as human-readable memory;
- Prime as later improvement/evals;
- separate Jarvis build authority vs Agent 0 production authority.

Their stage/status labels are historical and are superseded by live evidence + the reconciliation.

### 4. Live Builder Stage-1 evidence — newer than the roadmaps

Builder Stage 1 was completed in the actual private `mac313248/jarvis-agencyos` repository.

Latest owner-supplied freeze evidence:
- reviewed implementation SHA: `6fc6d373b4ad142dab0e6d863a38e934c6316db2`;
- merge commit: `ab9b4dbb7c146fe1faaf1d2aeea2e2cb62e2dc5d`;
- PR #56 merged to `main`;
- CI `phase1` success;
- business-write autonomy disabled.

The real Stage-1 AgencyOS task also produced a new security finding now incorporated into this SOT: unknown/external events fail closed, and trusted-internal provenance must be non-forgeable and created/enforced by trusted infrastructure.

### 5. Prior Secure Core candidate evidence — reusable but not current PASS

An earlier unmerged `phase-1/secure-core-spine` branch built useful candidate work including:
- migrations 0001–0008;
- roles + trusted tenant context;
- RLS/FORCE RLS;
- tenants/users/memberships;
- owner auth skeleton;
- authority/proposal/approval/policy;
- events/state/evidence;
- receipts/PII subject refs;
- authority/kill epochs;
- SOT build binding.

Its reviewed implementation SHA was `20c64b759c3f6aced3879e2872cca76326e58914` before the Builder-first work diverged.

This is **acceleration input**, not something to blind-merge. Current `main` + revised SOT must control the new Secure Core branch.

## Strong research evidence retained

The frozen design continues to rely on the prior evidence base around:
- task-dependent multi-agent coordination;
- deterministic orchestration/verification;
- Cursor native coding runtime capabilities;
- PostgreSQL RLS;
- DBOS durable workflows;
- MCP as interoperability rather than authority.

Broad architecture research remains closed.

## Targeted research rule

Do not start another broad pass.

Research only when:
- a live implementation test contradicts a lock;
- current official provider behavior is required to implement a connector;
- a provider changes materially;
- a new irreversible risk appears.

For implementation questions, prefer current first-party/official documentation, then source repositories/primary evidence.

## Canonical platform references retained

- PostgreSQL RLS / transactions / PITR
- DBOS documentation
- Cursor coding-agent documentation
- GitHub protected branch / CI documentation
- Hermes documentation
- MCP security considerations
- provider-specific official docs as connectors are implemented

The full Project research history remains supporting evidence, not current implementation state.
