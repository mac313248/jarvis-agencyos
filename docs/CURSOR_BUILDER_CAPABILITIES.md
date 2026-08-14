# Cursor builder capabilities

Repo-native Cursor capabilities for Cloud Agents and Automation runs. Delivery is Git state, not laptop `~/.cursor/*` plugins.

Cursor is the execution plane. Jarvis / Builder Core remains the authority plane.

## What is available

| Capability | Location | Role |
|---|---|---|
| Cursor SDK guidance | `.cursor/skills/cursor-sdk/` | Official skill + references for `@cursor/sdk` |
| CLI for Agents guidance | `.cursor/skills/cli-for-agents/` | How to design agent-friendly CLIs |
| Cursor Team Kit skills | `.cursor/skills/<name>/` | Workflow library (CI, review, shipping, verify, cleanup) |
| Superpowers skills | `.cursor/skills/<name>/` | Process library (brainstorm, plans, TDD, debugging, reviews) |
| Multitask | `.cursor/skills/multitask/` | Cloud Agent `/multitask` — parallel Task fan-out (desktop `/multitask` is IDE-only) |
| Parallel (parallel.ai) | `.cursor/skills/parallel-*`, `.cursor/commands/` | Web search/extract/research/enrich via pinned `parallel-cli` |
| Team Kit subagents | `.cursor/agents/` | `ci-watcher`, `thermo-nuclear-code-quality-review` |
| Team Kit rules | `.cursor/rules/` | `no-inline-imports`, `typescript-exhaustive-switch` (TS globs only) |
| Jarvis authority overlay | `.cursor/rules/jarvis-authority.mdc` | Always-on; convenience workflows cannot set PASS/DONE |
| Runtime SDK | `package.json` → `@cursor/sdk` | Primary programmatic integration via `CursorProvider` |

Provenance: `.cursor/vendor/cursor-plugins/PROVENANCE.json`.

## Worker rules

1. Use repo-native skills when relevant. Do not depend on the owner's local Cursor plugin install.
2. Team Kit and Superpowers are workflow libraries, not authority. Superpowers skill order does not override AGENTS.md or locked SOT.
3. `@cursor/sdk` is the primary Jarvis programmatic Cursor integration. Do not replace `CursorProvider`.
4. `cli-for-agents` is guidance for building agent-friendly CLIs. It is not the Cursor Agent CLI executable.
5. The `agent` CLI binary is separate and optional. **CLI binary optional/not required — SDK remains primary.**
6. Jarvis harness rules override convenience workflows (`review-and-ship`, `new-branch-and-pr`, `loop-on-ci`, `fix-ci`, `fix-merge-conflicts`, `make-pr-easy-to-review`, Superpowers process skills).
7. Workers never self-certify PASS/DONE.
8. Production / business credentials never belong in coding workers.

## Cloud discovery

Official Cursor contract: Cloud Agents clone the repository and discover `.cursor/skills/`, `.cursor/agents/`, and `.cursor/rules/*.mdc` from that checkout.

This repository does not claim slash-menu visibility in an Automation UI unless a live UI smoke observed it. Layout + official discovery contract is the configured proof.

## Environment

`.cursor/environment.json` runs `npm ci && npm install -g @openai/codex && pip3 install --user 'parallel-web-tools[cli]==0.9.2'` on the default Cloud image. Checkout supplies skills; `npm ci` supplies `@cursor/sdk`; the official Codex CLI install supplies the independent-review binary; pinned Parallel CLI enables `/parallel-setup` web tools. No production credentials in snapshots. Secrets such as `CURSOR_API_KEY`, `CODEX_API_KEY`, and `PARALLEL_API_KEY` stay in the Cursor Cloud dashboard, never in source, logs, or environment snapshots.
