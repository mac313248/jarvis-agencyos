# JARVIS / AGENCYOS — MASTER SOT

Status: **FINAL ARCHITECTURE FREEZE — AUDIT CORRECTIONS APPLIED — 2026-08-10**

This is the clean implementation authority for Jarvis / AgencyOS.

It incorporates:
- Research Passes 1–18;
- the independent adversarial audit;
- the owner decisions made after that audit.

## Owner decisions now locked

1. **Cross-business privacy**
   - Jarvis may compare/share across the owner's own first-party businesses.
   - Outside customer/client tenants remain isolated from each other and do not influence another tenant's output.

2. **High-risk approval**
   - V1 requires the owner + step-up MFA.
   - Two-human approval is not mandatory in V1.
   - High-risk approvals must still bind to an exact proposal/request.

3. **Customer deletion**
   - Identifiable customer data must be deleted from operational data, evidence surfaces, memory/indexes/caches and derived artifacts where applicable.
   - Only non-identifying audit proof may remain unless a legal retention rule explicitly requires otherwise.

## Canonical file authority

`06_SYSTEM_CONTRACTS.md` is the **single canonical schema/contract authority**.

Other files describe behavior and policy and MUST reference 06 rather than create competing schema definitions.

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

The coding agent:
- may READ the SOT;
- may NOT silently modify it;
- must stop if the repo SOT hashes do not match the approved manifest.

A later architecture change requires a new approved SOT package + manifest + dedicated Git commit.

## Governing rule

Do not reopen architecture because another design is interesting.

Reopen only if live evidence proves a frozen requirement cannot be implemented safely.

No business-write autonomy is enabled merely because code is complete.
