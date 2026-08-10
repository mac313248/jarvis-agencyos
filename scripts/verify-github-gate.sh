#!/usr/bin/env bash
# scripts/verify-github-gate.sh
# Acceptance #45 (Cursor builder cannot merge failed CI) — live GitHub gate verification.
#
# Run this from a NORMAL terminal (not Cursor's sandboxed terminal), where
# api.github.com is reachable and `gh` can authenticate. It:
#   1. verifies `gh` auth;
#   2. detects the real Phase 1 status-check name from a recent workflow run;
#   3. inspects branch protection / rulesets on mac313248/jarvis-agencyos;
#   4. if an active rule already requires the Phase 1 CI check before merge,
#      prints the exact enforcement evidence (ALREADY_ENFORCED);
#   5. otherwise configures the MINIMAL branch protection on main requiring
#      that check (enforce_admins=true, no force pushes), prints the config;
#   6. re-inspects and prints a final verdict.
#
# It only touches mac313248/jarvis-agencyos. It does NOT alter wrong-owner-backup
# and does NOT merge Phase 1.
#
# Usage:  bash scripts/verify-github-gate.sh
set -euo pipefail

# Drop any inherited GH_TOKEN/GITHUB_TOKEN so gh uses the macOS keychain
# login (mac313248) instead of a stale/invalid inherited token.
unset GH_TOKEN GITHUB_TOKEN || true

REPO="mac313248/jarvis-agencyos"
BRANCH="main"
PHASE1_WORKFLOW="phase-1.yml"

echo "============================================================"
echo "# GitHub gate verification for $REPO (branch $BRANCH)"
echo "============================================================"

echo "=== 1. gh auth status ==="
gh auth status

echo "=== 2. repo access ==="
gh api "repos/$REPO" --jq '{private:.private, default_branch:.default_branch, permissions:.permissions}'

echo "=== 3. detect real Phase 1 status-check name ==="
# Find the most recent successful run of the phase-1 workflow and read its check name.
CHECK_NAME="$(gh api "repos/$REPO/actions/workflows" --jq ".workflows[] | select(.path==\".github/workflows/$PHASE1_WORKFLOW\") | .name" | head -1)"
if [ -z "$CHECK_NAME" ]; then
  CHECK_NAME="Phase 1 — Secure Core Spine"
fi
# The status-check context is "<workflow_name> / <job_name>". The job is "phase1".
FULL_CHECK="$CHECK_NAME / phase1"
echo "detected check context: $FULL_CHECK"

echo "=== 4. existing branch protection on $BRANCH ==="
BP_JSON="$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>/dev/null || echo '')"
if [ -n "$BP_JSON" ]; then
  echo "$BP_JSON"
else
  echo "(no classic branch protection on $BRANCH)"
fi

echo "=== 5. existing rulesets ==="
gh api "repos/$REPO/rules" --jq '.rulesets[] | {id,name,target,conditions,enforcement}' 2>/dev/null || echo "(no rulesets)"

echo "=== 6. is the Phase 1 check already required? ==="
ALREADY=""
if [ -n "$BP_JSON" ]; then
  CTX="$(echo "$BP_JSON" | jq -r '.required_status_checks.contexts // [] | join(",")')"
  echo "existing required_status_checks.contexts: $CTX"
  if echo "$CTX" | grep -q "phase1"; then ALREADY="yes"; fi
fi
if [ -z "$ALREADY" ]; then
  # also check rulesets for the check
  RS="$(gh api "repos/$REPO/rules" --jq '.rulesets[] | select(.target=="refs/heads/main") | .id' 2>/dev/null || echo '')"
  for id in $RS; do
    CTX2="$(gh api "repos/$REPO/rules/$id" --jq '.parameters.required_status_checks.contexts // [] | join(",")' 2>/dev/null || echo '')"
    if echo "$CTX2" | grep -q "phase1"; then ALREADY="yes (ruleset $id)"; fi
  done
fi

if [ -n "$ALREADY" ]; then
  echo "ALREADY_ENFORCED: $ALREADY"
else
  echo "=== 7. configuring MINIMAL branch protection on $BRANCH ==="
  gh api "repos/$REPO/branches/$BRANCH/protection" \
    -X PUT \
    -f "required_status_checks[strict]=false" \
    -f "required_status_checks[contexts][]=$FULL_CHECK" \
    -f "enforce_admins=true" \
    -f "allow_force_pushes=false" \
    -f "required_pull_request_reviews[required_approving_review_count]=0" \
    -f "restrictions=null" \
    --silent || echo "(PUT branch protection failed — see message above)"
  echo "configured branch protection requiring: $FULL_CHECK"
fi

echo "=== 8. re-inspect final enforcement ==="
gh api "repos/$REPO/branches/$BRANCH/protection" --jq '{url, enforce_admins, allow_force_pushes, required_status_checks:{contexts}, required_pull_request_reviews}' 2>/dev/null \
  || gh api "repos/$REPO/branches/$BRANCH/protection" --jq '.' 2>/dev/null \
  || echo "(could not re-read protection)"

echo "============================================================"
echo "# Paste everything above back to the builder."
echo "============================================================"
