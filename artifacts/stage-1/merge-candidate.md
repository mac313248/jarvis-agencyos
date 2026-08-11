# Stage-1 Freeze — Exact Merge Candidate

Status: **PREPARED — AWAITING CODEX MERGE-READINESS REVIEW**  
Merge authorized: **NO** (do not merge until review PASS)

## Exact merge candidate

| Field | Value |
|---|---|
| Implementation SHA | `54b038ebcabc6ef6f40a1bcab5838abef4119213` |
| Freeze branch | `stage1/freeze-merge-ready` |
| Source proof PR | [#51](https://github.com/mac313248/jarvis-agencyos/pull/51) (`stage1/inbound-authenticity-gate-b7e2`) |
| Base | `main` @ `5b861f2afefe41090de57ddcdbafd22435160056` |
| Supersedes | Draft PR [#12](https://github.com/mac313248/jarvis-agencyos/pull/12) (Stage-1 builder tip without authenticity gate) |

## Why this SHA

1. Contains full Builder Stage-1 core tip `420de2ae…` as ancestor.
2. Adds the Jarvis-accepted fail-closed inbound authenticity gate (real Stage-1 proof).
3. Exact-SHA CI success on PR #51.
4. Jarvis task `task_2ff41a80-…` → `ACCEPTED` with Codex review `PASS`, verify `PASS`, `OWNER_INTERVENTIONS=0`.
5. Local freeze re-run at this SHA: SOT VERIFY PASS; `npm test` 369/369; builder-stage1 90/90; inbound gate 12/12.

## Classification lock included

- External/unknown events: registry + verifier; missing/failed/unknown = REJECT.
- Trusted-internal: only positive trusted infrastructure provenance may bypass external auth.
- No caller-supplied field may classify trusted/internal.
- No `NOT_APPLICABLE` passthrough for unknown/external events.

## Hard stops

- Do **not** merge to `main` until Codex merge-readiness review returns **PASS**.
- Do **not** enable business-write autonomy.
- Do **not** modify `docs/master-sot/`.
- Keep implementation SHA distinct from any later evidence/review-only SHA.
