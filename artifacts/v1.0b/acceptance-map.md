# V1.0B Agent 0 T0/T1 — Acceptance Map

| Requirement | Status | Evidence |
|---|---|---|
| Agent 0 T0 observe | PASS | `src/runtime/agent0.js`, `tests/agent0-v1.0b.test.mjs` |
| Agent 0 T1 recommend/draft | PASS | `src/runtime/agent0.js`, `tests/agent0-v1.0b.test.mjs` |
| Jarvis owner briefing | PASS | `src/jarvis/briefing.js`, `tests/agent0-v1.0b.test.mjs` |
| First-party portfolio synthesis | PASS | `synthesizeFirstPartyPortfolio()` |
| Third-party isolation | PASS | `PORTFOLIO_ISOLATION` rejection test |
| Business-write autonomy | DISABLED | `BUSINESS_WRITE_AUTONOMY=false` |
