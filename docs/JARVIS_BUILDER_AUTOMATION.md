# Jarvis Builder Automation contract

This document tells a future Cursor Automation how to invoke Jarvis after
the control-plane work is merged. **Do not enable the Automation from this
change.** The live Jarvis Builder Automation remains owner-gated.

Cursor is the execution plane. Jarvis / Builder Core remains the authority
plane. Automation Memory and chat history are not authoritative.

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
4. If `decision` is `NOOP`, stop.
5. If `decision` is `NEEDS_OWNER` or `BLOCKED`, report the exact `reason` /
   `owner_action` only. Do not invent work.
6. If `decision` is `EXECUTE` or `REPAIR`, execute the emitted worker contract
   at `worker_contract`. The tick may already have launched CursorProvider.
7. After the worker is terminal, run the existing Builder verify / Codex
   review / GitHub path against the exact candidate SHA. Worker
   self-reported success is never PASS/DONE.
8. Persist durable Builder Core state. Stop at a stable handoff.

## Hard rules

- One logical objective per trigger.
- Claim only through Builder Core. Do not create a second task queue.
- Do not select Hermes, voice, Obsidian, Prime, extra coding workers,
  future-phase V1.1 work, or owner-blocked work.
- Do not enable business-write autonomy.
- Do not treat orientation slice markers as release-gate PASS.
- Do not let Automation Memory override Git HEAD, `control/prd.json`, or
  Builder Core SQLite state.
- Production credentials never belong in the worker, prompt, or evidence.
