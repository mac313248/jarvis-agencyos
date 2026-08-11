# Stage-1 Freeze — Acceptance Map

Scope: **Builder Stage-1 + fail-closed inbound authenticity gate** on implementation SHA  
`6fc6d373b4ad142dab0e6d863a38e934c6316db2`.

Business-write autonomy remains **DISABLED**.

## Builder Stage-1 surface

| Item | Claim | Disposition | Evidence |
|---|---|---|---|
| Jarvis Interface / Builder Core boundary | Distinct trust domains; no business-core authority via Stage-1 surface | PASS | `tests/builder-stage1-core.test.mjs` |
| Durable task/run/candidate/event store | Reconstructs nonterminal state | PASS | builder-stage1-core |
| Immutable task lock | Acceptance/paths/tools/intent hash-bound | PASS | builder-stage1-core |
| CursorProvider worker | Sole coding worker; never self-certifies DONE | PASS | builder-stage1-provider |
| Exact GitHub landing truth | Branch/SHA/PR/CI bound; worker prose ignored | PASS | builder-stage1-candidate-verifier |
| Exact-SHA CI wait | Pending≠PASS; timeout BLOCKED; no smoke bypass | PASS | builder-stage1-ci-wait |
| Deterministic verifier | SHA-bound PASS/FAIL/BLOCKED | PASS | builder-stage1-candidate-verifier |
| Codex review gate | REQUEST_CHANGES blocks; reviewer cannot mutate authority | PASS | builder-stage1-review-retry |
| Approval binding | proposal_id + content_hash + candidate/commit | PASS | builder-stage1-review-retry |
| Stale-run fencing | Cancelled/stale cannot authorize | PASS | builder-stage1-review-retry + failure-battery |
| Bounded retry | Fresh factory_run_id; caps; hard policy non-retryable | PASS | builder-stage1-review-retry |
| Tool / research policy | Default deny; cannot mutate locked authority | PASS | builder-stage1-tool-recovery |
| Restart recovery | No duplicate launch; fail-closed on ambiguity | PASS | builder-stage1-tool-recovery |
| Secret redaction | No credentials in evidence/logs/errors | PASS | builder-stage1-secrets-redact |
| Failure battery | Crash/stale/policy fail-closed paths | PASS | builder-stage1-failure-battery |
| Owner orchestration path | `jarvis:task` / EXECUTE_SOFTWARE_TASK end-to-end | PASS | builder-stage1-orchestration + live proof |

## Inbound authenticity (SOT #15–#17 + owner classification lock)

| Case | Claim | Disposition | Evidence |
|---|---|---|---|
| A | Verified external accepted + materializes | PASS | inbound-authenticity-gate.test A |
| B | Unsigned/missing rejected | PASS | B |
| C | Failed verification rejected | PASS | C |
| D | Unknown source rejected | PASS | D |
| E | Rejected never materializes | PASS | E |
| F | Existing contracts-auth behavior remains | PASS | F |
| G | Unknown/unlisted external event_type fail-closed (no NOT_APPLICABLE) | PASS | G |
| H | Caller-spoofed internal/trusted labels rejected | PASS | H |
| I | Only trusted-internal provenance may bypass external auth | PASS | I |
| Registry-only connectors | Caller-supplied connector cannot authorize | PASS | extra regression |
| Trusted verifier boundary | Payload verification claims rejected | PASS | owner lock + prior Codex findings |
| Replay/dedupe | One canonical transition | PASS | replay test |
| Fake HMAC restriction | Real `authver://hmac/*` fail closed | PASS | hmac regression |

## Live Jarvis real-task proof

| Field | Value |
|---|---|
| task_id | `task_2ff41a80-f37e-438a-93ff-f917f6b69d12` |
| status | ACCEPTED / DONE |
| attempts | 4 (PASS on attempt 4) |
| candidate | `cand_93cdffd8-109f-4737-b82f-365b1ac2a0f3` |
| freeze_implementation_sha | `6fc6d373b4ad142dab0e6d863a38e934c6316db2` |
| prior_jarvis_proof_commit | `54b038ebcabc6ef6f40a1bcab5838abef4119213` |
| draft PR | #51 |
| verify | PASS |
| Codex | PASS |
| CI | success |
| OWNER_INTERVENTIONS | 0 |

## Explicitly not claimed by this freeze

- Merge to `main` (blocked until Codex merge-readiness PASS)
- Business-write autonomy
- Live provider webhooks / production deployment
- V1.0 FOUNDATION complete / V1_0_COMPLETE
- Closing or auto-merging superseded draft PRs (#12, #42–#50)

## Coding acceptance relevant to merge gate

| # | Claim | Disposition |
|---|---|---|
| 45 | Cannot merge failed CI | PASS on candidate (CI success); merge still gated on review |
| 46 | Reviewer cannot override deterministic failure | PASS (Stage-1 review tests) |
| 47 | Protected main rejects unauthorized direct push | Relies on existing live GitHub protection (phase-1 evidence); not re-opened here |
| 48 | Build records approved SOT manifest hash | PASS (`build-binding.json`) |
| 49 | Refuse on SOT mismatch | PASS (`scripts/verify-sot.mjs`) |
