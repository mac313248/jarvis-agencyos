# JARVIS / AGENCYOS — MASTER SOT

Status: **ARCHITECTURE FREEZE v1.1 — BUILDER STAGE 1 PROVEN — AGENCYOS SECURE CORE CURRENT — 2026-08-11**

This is the implementation authority for Jarvis / AgencyOS.

It incorporates:
- Research Passes 1–18;
- the independent adversarial audit;
- the owner decisions made after that audit;
- the August 10 Jarvis architecture reconciliation;
- live Builder Stage-1 evidence from the actual `jarvis-agencyos` repository;
- the inbound-authenticity corrections discovered by the real Stage-1 AgencyOS task.

## Current implementation state

**Builder Stage 1 is complete and frozen.**

Proven in the live repository:
- durable task/run/candidate state;
- Cursor as the first `WorkerProvider`;
- isolated worker execution;
- exact branch/SHA/PR/CI binding;
- deterministic verification;
- independent Codex review;
- bounded retry/recovery and stale-run fencing;
- secret redaction;
- one real AgencyOS task completed with zero routine owner AI-to-AI relay.

The reviewed Stage-1 freeze was merged to `main` on 2026-08-11.

**Current build phase: AgencyOS Secure Core.**

The fastest safe sequence is:

`reconcile prior secure-core work`
→ `read-safe foundation`
→ `Agent 0 T0/T1 can begin`
→ `write-safe foundation`
→ `selected T2 only after write gates`

No business-write autonomy is enabled merely because code exists.

## Logical trust domains

The owner experiences one Jarvis, but three logical trust domains remain distinct:

1. **Jarvis Interface / Mediator** — owner-facing intent, briefings, approvals, routing.
2. **Builder Core** — software-work task/run/candidate/verification authority.
3. **AgencyOS Business Core** — tenant business state, policy, grants, workflows, executor, receipts.

They may share deployment infrastructure initially. They must not share authority implicitly.

## Owner decisions locked

1. **Cross-business privacy**
   - Jarvis may compare/share across the owner's authorized first-party businesses.
   - Outside customer/client tenants remain isolated from each other and do not influence another tenant's output.

2. **High-risk approval**
   - V1 requires the owner + step-up MFA.
   - Two-human approval is not mandatory in V1.
   - High-risk approvals bind to the exact proposal/request and current relevant state.

3. **Customer deletion**
   - Identifiable customer data must be deleted from operational data, evidence surfaces, memory/indexes/caches and derived artifacts where applicable.
   - Only non-identifying audit proof may remain unless a legal retention rule explicitly requires otherwise.

4. **Builder-first execution order**
   - The thin Builder is built and proven first.
   - The Builder is now used to accelerate AgencyOS Secure Core and Agent 0.
   - This does not weaken any business-runtime security gate.

## Canonical file authority

`06_SYSTEM_CONTRACTS.md` is the **single canonical AgencyOS business-runtime schema/contract authority**.

Builder Core Stage-1 contracts are frozen in the implemented Builder code and its Stage-1 evidence. This SOT defines the boundary between Builder Core and AgencyOS Business Core and does not duplicate the Builder's already-implemented internal schemas.

Other SOT files describe behavior and policy and MUST reference 06 rather than create competing AgencyOS business-runtime schema definitions.

## Read order

1. `01_ARCHITECTURE_LOCKS.md`
2. `05_PRODUCT_BEHAVIOR.md`
3. `06_SYSTEM_CONTRACTS.md`
4. `07_AUTHORITY_SECURITY_EXECUTION.md`
5. `08_RUNTIME_WORKFLOWS_SPECIALISTS.md`
6. `09_INTELLIGENCE_LEARNING.md`
7. `10_OBSERVABILITY_RECOVERY.md`
8. `11_TEMPLATE_ONBOARDING.md`
9. `12_ACCEPTANCE_AND_IMPLEMENTATION.md`
10. `14_CODING_AGENT_BOOTSTRAP_AND_RUNBOOK.md`

Research/audit support:
- `02_RESEARCH_DECISION_LEDGER.md`
- `03_CONTRADICTIONS_AND_CORRECTIONS.md`
- `04_LIVE_VERIFICATION_BACKLOG.md`
- `13_SOURCE_INDEX.md`

## SOT synchronization rule

The ChatGPT Project copy and the Mac Mini Git repository copy MUST match the included `SOT_SYNC_MANIFEST.sha256`.

The Mac Mini repo stores this SOT under:

`docs/master-sot/`

The coding system:
- may READ the SOT;
- may NOT silently modify it;
- must stop if repo SOT hashes do not match the approved manifest.

An architecture change requires:
1. an approved SOT package;
2. a new manifest;
3. a dedicated Git commit;
4. then implementation.

## Governing rule

Do not reopen architecture because another design is interesting.

Reopen only if live evidence proves a frozen requirement cannot be implemented safely or a genuinely irreversible new risk appears.

**Speed rule:** use the proven Builder, reuse compatible prior work, parallelize only dependency-safe work, and do not make optional infrastructure a prerequisite for read-only value.
