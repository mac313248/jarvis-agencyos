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

- **Node.js**: 22 (default Cursor Cloud image; matches CI).
- **Install**: `npm ci && npm install -g @openai/codex && pip3 install --user 'parallel-web-tools[cli]==0.9.2'` (runs automatically during environment builds).
- **SOT guard**: `npm run verify:sot` — run before security/business-runtime work.
- **Migrations**: `npm run migrate` (uses PGlite in `.pgdata`).
- **Full test suite**: `npm test` (PGlite-based; ~30s).
- **PostgreSQL boundary tests**: `npm run test:v1.0a-postgres` (embedded-postgres, multi-process).
- **Targeted suites**: `npm run test:v1.0b-agent0`, `npm run test:v1.0c-write-safe`, `npm run test:builder-stage1`.
- **No external DATABASE_URL required** — tests spin up disposable PGlite or embedded-postgres clusters.
- **GitHub live smoke test** (`builder-stage1-ci-wait`) requires GitHub credentials and may fail without them; other tests do not depend on it.
- **Secrets**: add production/staging credentials via the Cursor Cloud dashboard, not in source. Parallel web tools need `PARALLEL_API_KEY`.

## Cursor builder capabilities

Repo-native skills live in `.cursor/skills/` (Team Kit, Superpowers, multitask, Parallel, Cursor SDK guidance, CLI-for-Agents). Use them when relevant.

- Team Kit and Superpowers are **workflow libraries**, not authority.
- `/multitask` is available as `.cursor/skills/multitask/` (Cloud Agent equivalent of the desktop Agents Window command).
- `/parallel-setup` and Parallel web skills are available under `.cursor/skills/parallel-*` and `.cursor/commands/`. CLI is pinned via environment install; set `PARALLEL_API_KEY` in the Cloud dashboard.
- `@cursor/sdk` (existing `CursorProvider`) is the primary programmatic Cursor integration.
- `cli-for-agents` is CLI-design guidance. The `agent` binary is optional/not required.
- Jarvis harness rules override convenience workflows. Workers never self-certify PASS/DONE.
- Production credentials never belong in coding workers.

Details: `docs/CURSOR_BUILDER_CAPABILITIES.md`.
