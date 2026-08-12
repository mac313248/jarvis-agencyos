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

## Cursor Cloud specific instructions

- **Node.js**: 22 (pinned via `.cursor/Dockerfile`; matches CI).
- **Install**: `npm ci` (runs automatically during environment builds).
- **SOT guard**: `npm run verify:sot` — run before security/business-runtime work.
- **Migrations**: `npm run migrate` (uses PGlite in `.pgdata`).
- **Full test suite**: `npm test` (PGlite-based; ~30s).
- **PostgreSQL boundary tests**: `npm run test:v1.0a-postgres` (embedded-postgres, multi-process).
- **Targeted suites**: `npm run test:v1.0b-agent0`, `npm run test:v1.0c-write-safe`, `npm run test:builder-stage1`.
- **No external DATABASE_URL required** — tests spin up disposable PGlite or embedded-postgres clusters.
- **GitHub live smoke test** (`builder-stage1-ci-wait`) requires GitHub credentials and may fail without them; other tests do not depend on it.
- **Secrets**: add production/staging credentials via the Cursor Cloud dashboard, not in source.
