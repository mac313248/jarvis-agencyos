# Jarvis Builder Automation contract

This document tells a future Cursor Automation how to invoke Jarvis after
the control-plane work is merged. **Do not enable the Automation from this
change.** The live Jarvis Builder Automation remains owner-gated.

Cursor is the execution plane. Jarvis / Builder Core remains the authority
plane. Automation Memory and chat history are not authoritative.

## Durable authorities

Unattended Automation must never rely on persistent Cloud sandbox disk.
A fresh sandbox has an empty filesystem. The durable authorities are:

1. **Master SOT / Git** — frozen product intent and implementation authority.
2. **Shared Builder Postgres** — task/run/candidate/retry/fencing authority.
3. **GitHub / exact-SHA evidence** — candidate landing, PR, CI.
4. **Cursor provider state** — the live worker identified by persisted
   `provider_run_id` / `provider_agent_id`.

Local SQLite (`.data/builder/jarvis-tasks.sqlite`) is for local/manual
development and deterministic tests only. It is not Automation authority.
Filesystem `jarvis-tick.lock` is an intra-VM duplicate guard only. The
database is the cross-sandbox fencing authority.

## Shared store (required for unattended Automation)

Set these secrets/config values on the Automation. Do not put them in Git.

```bash
JARVIS_BUILDER_STORE=postgres
JARVIS_BUILDER_DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
JARVIS_BUILDER_UNATTENDED=1
```

Optional:

```bash
JARVIS_BUILDER_SCHEMA=jarvis_builder
```

`JARVIS_BUILDER_DATABASE_URL` must point at a dedicated Builder database or
a dedicated `jarvis_builder` schema with dedicated credentials. Do not grant
Builder workers AgencyOS production/business privileges.

If shared-store mode is required and the URL is missing or unreachable,
`jarvis:tick` returns `BLOCKED` and does **not**:

- create `.data/builder/jarvis-tasks.sqlite`
- fall back to local SQLite
- launch Cursor workers

Local/manual development may set `JARVIS_BUILDER_STORE=sqlite` or omit the
store mode (SQLite remains the explicit local default).

## Invocation

1. Fetch latest `main`.
2. Run one trigger:

```bash
npm run jarvis:tick -- --trigger hourly
npm run jarvis:tick -- --trigger checks_failed
npm run jarvis:tick -- --trigger changes_requested
npm run jarvis:tick -- --trigger manual_smoke
```

Read-only orientation (no writes):

```bash
npm run orientation
```

Explicit SHA-scoped evidence:

```bash
npm run orientation:evidence
```

3. Parse the single JSON decision from `jarvis:tick`.
4. If `decision` is `NOOP`, stop. `AWAITING_VERIFY_HANDOFF` and
   `WORKER_IN_FLIGHT` are stable handoffs, not new work.
5. If `decision` is `NEEDS_OWNER` or `BLOCKED`, report the exact `reason` /
   `owner_action` only. Do not invent work.
6. If `decision` is `EXECUTE` or `REPAIR`, execute the emitted worker contract
   at `worker_contract`. The tick may already have launched CursorProvider.
7. After the worker is terminal, a **fresh** sandbox must reconnect to the
   same shared Builder store, read the persisted `factory_run_id` /
   `provider_run_id` / `provider_agent_id`, and collect / verify that exact
   worker. Do not launch a duplicate. Worker self-reported success is never
   PASS/DONE.
8. Persist durable Builder Core state in the shared Postgres store. Stop at
   a stable handoff.

## Reconstruction

A completely fresh Cloud Agent with an empty filesystem must connect to the
shared Builder store and reconstruct:

- current task / `logical_work_id`
- current `factory_run_id`
- `provider_run_id` / Cursor agent id
- candidate / PR association
- retry count
- stale/superseded fencing
- next permitted action

No chat history or Automation Memory may be required.

## Hard rules

- One logical objective per trigger.
- Claim only through Builder Core database-authoritative claiming. Do not
  create a second task queue.
- Two independent Automation sandboxes racing for the same eligible work
  must produce exactly one successful claim, one factory run, and one Cursor
  dispatch. Competitors return `NOOP` / `BLOCKED` / already-claimed /
  `WORKER_IN_FLIGHT`.
- A stale/superseded run must never regain authority.
- Do not select Hermes, voice, Obsidian, Prime, extra coding workers,
  future-phase V1.1 work, or owner-blocked work.
- Do not enable business-write autonomy.
- Do not treat orientation slice markers as release-gate PASS.
- Do not let Automation Memory override Git HEAD, `control/prd.json`, or
  shared Builder Postgres state.
- Production credentials never belong in the worker, prompt, evidence, or
  Builder tables/events.
