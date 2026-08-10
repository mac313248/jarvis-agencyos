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
