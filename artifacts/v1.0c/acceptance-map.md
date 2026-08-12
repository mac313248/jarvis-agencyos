# V1.0C Write-Safe Foundation — Acceptance Map

Base: `phase-build/agencyos-secure-core` @ `2cb6f58f28f0e3d2bb8d52d7c85150d9f79c0fb3` (V1.0A/B PASS)  
Business-write autonomy: **DISABLED**  
DBOS: **NOT REQUIRED** for V1.0C (no selected durable T2 workflow)

## Disposition summary (current SOT numbering)

| # | Requirement | Disposition | Evidence |
|---|---|---|---|
| 9 | Owner session authentication for APPROVE | PASS | `approval.js` + `contracts-auth` + `v1.0c-write-safe` |
| 10 | High-risk step-up MFA | PASS AS-IS | `contracts-auth` |
| 11 | Exact proposal/request/session/principal binding | PASS | `approval.js` always requires session for APPROVE |
| 12 | State mutation invalidates approval | PASS AS-IS | `contracts-auth` |
| 13 | Raw text approval worthless | PASS AS-IS | `contracts-auth` |
| 14 | Revoked/expired grant blocks | PASS AS-IS | `trusted-executor` |
| 21–23 | Materiality / non-silenceable / 10k wakes / hash notify | PASS AS-IS | `observability` |
| 24–26 | Idempotency / at-most-once / crash resume | PASS AS-IS | `trusted-executor` |
| 27 | PITR does not resurrect committed effect | PASS | `v1.0c-write-safe` #27 |
| 28 | No autonomous retry after ambiguity without idempotency+postcondition | PASS | `effect-ambiguity` + executor + unsafe caps → APPROVAL_REQUIRED |
| 29 | Browser/Orgo fallback only after durable VERIFIED ABSENT | PASS | durable_evidence required; caller-only refused |
| 30–31 | Verified receipts; unknown never SUCCEEDED | PASS AS-IS | `trusted-executor` |
| 32 | Single-flight tenant+subject+routine+stage | PASS | `single-flight.js` + migration 0021 |
| 33 | Cancelled/expired cannot commit late | PASS | enforce_single_flight fail-closed + tests |
| 34 | Semantic action dedupe | PASS | claims + release on failed commit |
| 35–38 | Kill/revocation TOCTOU / epochs / outage / zombie | PASS AS-IS | `authority-kill` |
| 39–42 | Write-path reconciliation | PASS AS-IS | `reconciliation` |
| 43–47 | Privacy / deletion / opaque subject_ref | PASS AS-IS | `security-privacy-acceptance` |

## New / repaired modules

- `migrations/0021_v1_0c_single_flight.sql`
- `src/runtime/single-flight.js`
- `src/runtime/effect-ambiguity.js`
- `src/contracts/approval.js` (session always required for APPROVE)
- `src/runtime/trusted-executor.js` (gates + ambiguity policy elevation + semantic claim lifecycle)
- `tests/v1.0c-write-safe.test.mjs`

## Explicit non-claims

- No T2/T3/T4 routine enabled
- No live external provider writes
- Agent 0 write orchestration must pass `enforce_single_flight` + binding fields when enabling customer-facing writes (foundation gates exist; T2 wiring is V1.1)
- DBOS not adopted for a new durable workflow in this slice

## Verification

- `npm run test:v1.0c-write-safe` → PASS
- `npm test` → 391/391 PASS
- SOT VERIFY → PASS
- Security review → PASS WITH FIXES (material findings repaired: fail-closed flight, durable fallback evidence, semantic claim release, ambiguity min_verdict)
