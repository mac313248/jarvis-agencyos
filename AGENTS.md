# AGENTS.md

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
