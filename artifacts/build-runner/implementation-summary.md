# Local Build Runner — Implementation Summary

## Scope
Thin LOCAL BUILD RUNNER only. Does not start any V1.0 application phase.
Contracts the next smallest valid V1.0 Foundation slice from SOT and drives
Cursor (sole writer) + Codex (read-only reviewer).

## Branch / base
- Branch: `phase-build/local-build-runner`
- Repair cycle: Codex FAIL blockers (CLI arg order, dry-run resume, verdict ambiguity)
- Approved SOT manifest: `8454dc306866ced3a5b7f7a827131cbba3587a741b2c948c16e0b1bfde226a87`

## SOT
- `node scripts/verify-sot.mjs` → **PASS**
- `docs/master-sot/` not modified

## Owner command
```text
cd /Users/sashairis/Projects/jarvis-agencyos
./scripts/run-next-phase
```
Dry-run: `./scripts/run-next-phase --dry-run`

## Files
- `scripts/build-runner.mjs` — runner (verify → contract → Cursor → tests → Codex)
- `scripts/run-next-phase` — owner shell wrapper (`chmod +x`, cds to repo root)
- `tests/build-runner.test.mjs` — focused harness tests (25)
- `.gitignore` — ignore `.tmp-build-runner-tests/`, runtime `state.json`, `current-phase.json`
- `artifacts/build-runner/implementation-summary.md` — this evidence

## Native invocation (exact)
Cursor (keychain-backed; never prints/logs the key):
```text
CURSOR_API_KEY="$(security find-generic-password -a "$USER" -s "agencyos.cursor.api_key" -w)" \
  cursor-agent --trust -p --force --output-format json "<prompt>"
```
Codex (read-only reviewer only; global `-a never` before `exec`):
```text
codex -a never exec -C /Users/sashairis/Projects/jarvis-agencyos -s read-only --ephemeral --json "<prompt>"
```

## Behavior
1. Verify repo root, approved SOT manifest, safe Git state
2. Determine next incomplete V1.0 Foundation slice from SOT evidence markers (no fixed phase count)
3. Materialize/validate `artifacts/build-runner/current-phase.json` with required fields + `business_write_autonomy: DISABLED`
4. Resumable via minimal `artifacts/build-runner/state.json`
5. Fail closed on dirty/ambiguous Git, zero/multiple verdict tokens, SOT mismatch, failed tests, unsafe auth
6. Dry-run contracts next slice only → `WAITING_ON_OWNER` + `dry_run_checkpoint:true` (no application changes); a later normal run resumes that checkpoint; genuine `dry_run_checkpoint:false` owner gates stay permanent
7. Deterministic tests before Codex; max 2 Codex verdicts; one bounded Cursor repair for `PASS_WITH_FIXES`; second verdict must be `PASS`
8. Stop only at `WAITING_ON_OWNER` | `WAITING_ON_ARCHITECTURE` | `FAILED_ACCEPTANCE_GATE` | `V1_0_COMPLETE`
9. No auto-merge; Cursor sole writer; no owner copy/paste between Cursor and Codex

## Next slice (dry-run)
`F-08` Trusted executor — contracted only; **not implemented** by this commit.

## Test results
- Focused runner: **25/25 PASS** (`node --test tests/build-runner.test.mjs`)
- Full regression: **90/90 PASS** (`npm test`)
- SOT VERIFY: **PASS**
- BUSINESS_WRITE_AUTONOMY: **DISABLED**
- Application phase files (e.g. `src/runtime/trusted-executor.js`): **absent**
