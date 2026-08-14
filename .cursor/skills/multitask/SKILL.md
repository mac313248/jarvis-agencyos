---
name: multitask
description: Run independent workstreams in parallel via async subagents. Use when the user types /multitask, asks to multitask, or has 2+ independent tasks that should not wait on each other.
---

# Multitask

## Purpose

Repo-native Cloud Agent equivalent of Cursor's desktop `/multitask` slash command: fan out independent work to parallel subagents instead of queuing sequentially.

Desktop Agents Window `/multitask` is a first-party product command and cannot be installed from the marketplace. This skill is the durable checkout-backed path for Cloud Agents and Automation runs.

## Authority

Jarvis / Builder Core remains the authority plane. This skill may coordinate parallel execution. It may **not** set PASS/DONE, merge eligibility, accepted evidence, task completion, or new product scope. `AGENTS.md` and locked SOT win on conflict.

## When to use

- User invokes `/multitask` or says "multitask"
- 2+ independent tasks with no shared mutable state
- Parallel research, fixes, or implementation slices that do not depend on each other's outputs

## When not to use

- Steps must run in order (later step needs earlier output)
- Shared files / schema / migration ownership would collide
- A single coherent design decision is still unresolved — brainstorm/plan first

## Procedure

1. **Read** `.cursor/skills/dispatching-parallel-agents/SKILL.md` and follow its independence rules.
2. **Split** the request into the smallest set of independent workstreams (usually 2–5).
3. **Dispatch in one response** using the `Task` tool with multiple parallel calls (same turn = parallel). Give each subagent:
   - Isolated prompt with full context (no inherited chat history)
   - Clear scope, constraints, and expected return shape
   - Explicit "do not touch" paths owned by sibling agents
4. **Keep dependent work sequential.** Only fan out the independent subset.
5. **Integrate** returned results: resolve conflicts, run deterministic verification for touched surfaces, and report what each stream did.
6. **Fail closed** on authority: if a stream would need PASS/DONE, merge, production credentials, or SOT changes, stop that stream and surface WAITING_ON_OWNER / WAITING_ON_ARCHITECTURE as appropriate.

## Return shape

Summarize per workstream: goal, outcome, files touched, blockers. Do not claim Jarvis PASS/DONE.
