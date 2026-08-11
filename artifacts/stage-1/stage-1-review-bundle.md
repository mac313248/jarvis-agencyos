# Stage-1 Freeze — Merge-Readiness Review Bundle (for Codex)

## Decision contract for the reviewer

Return exactly one primary verdict:

- `PASS`
- `PASS WITH FIXES`
- `FAIL`

Only flag material:

- SOT contradiction;
- security/tenant isolation flaw;
- inbound authenticity fail-open / forgeable trusted-internal bypass;
- Stage-1 authority bypass (worker/self-certify, stale-run, CI pending-as-pass, secret leakage);
- unsupported freeze/completion claim;
- broken merge-candidate binding (wrong SHA / evidence pretending to be implementation);
- code that silently enables business-write autonomy or redesigns frozen architecture.

Do not redesign for novelty. If fixes are needed, give the smallest concrete fix list.

## Scope under review

**Builder Stage-1 freeze merge candidate** = implementation SHA  
`54b038ebcabc6ef6f40a1bcab5838abef4119213`  
(branch `stage1/freeze-merge-ready`, sourced from PR #51).

Includes:

- full Stage-1 builder/orchestrator stack;
- fail-closed inbound authenticity gate with owner classification lock.

Does **not** claim:

- merge already authorized;
- V1.0 FOUNDATION / V1_0_COMPLETE;
- business-write autonomy;
- production deployment.

## What to review

1. `artifacts/stage-1/merge-candidate.md` — exact SHA/branch/PR binding.
2. `artifacts/stage-1/acceptance-map.md` — dispositions.
3. `artifacts/stage-1/build-binding.json` — SOT + implementation SHA binding.
4. `artifacts/stage-1/test-results.txt` + builder/inbound result files.
5. `artifacts/stage-1/sot-verification.txt`.
6. `artifacts/stage-1/jarvis-real-task-proof.json`.
7. Diff `5b861f2afefe41090de57ddcdbafd22435160056...54b038ebcabc6ef6f40a1bcab5838abef4119213`.
8. Especially: `src/runtime/inbound-authenticity-gate.js`, `src/builder/**`, `src/jarvis/**`, `tests/inbound-authenticity-gate.test.mjs`, `tests/builder-stage1-*.test.mjs`.
9. Confirm `docs/master-sot/` unchanged vs approved manifest.

## Mandatory owner classification lock

EXTERNAL OR UNKNOWN EVENT → trusted connector registry → authenticity verification → PASS may continue; missing/failed/unknown = REJECT.

TRUSTED INTERNAL EVENT → must be positively classified by trusted internal provenance → may bypass external connector authentication.

- NO caller-supplied field may classify an event as trusted/internal.
- NO NOT_APPLICABLE passthrough for unknown/external events.

## Builder claims (verify independently)

- SOT VERIFY: PASS
- Full suite: 369/369 PASS
- Builder Stage-1 suite: 90/90 PASS
- Inbound authenticity suite: 12/12 PASS
- Jarvis real-task proof: ACCEPTED / Codex PASS / CI success / OWNER_INTERVENTIONS=0
- Exact merge candidate SHA: `54b038ebcabc6ef6f40a1bcab5838abef4119213`
- BUSINESS_WRITE_AUTONOMY: DISABLED
- Merge: NOT YET AUTHORIZED

## Codex role

REVIEW-ONLY. Do not act as a concurrent writer. Do not merge.
