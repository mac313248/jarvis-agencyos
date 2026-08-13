// Shared Builder store row mappers. SQLite and PostgreSQL both persist JSON
// as text and timestamps as ISO-8601 strings so reconstruct output matches.

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  if (typeof text === 'object') return text;
  return JSON.parse(text);
}

export function rowToTask(row) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    intent: row.intent,
    intent_version: row.intent_version,
    acceptance_ref: row.acceptance_ref,
    allowed_paths: parseJson(row.allowed_paths_json, []),
    tool_manifest: parseJson(row.tool_manifest_json, {}),
    review_required: Boolean(row.review_required),
    status: row.status,
    priority: row.priority,
    max_attempts: row.max_attempts == null ? 2 : Number(row.max_attempts),
    max_runtime_ms:
      row.max_runtime_ms == null ? 1800000 : Number(row.max_runtime_ms),
    cost_budget_status: row.cost_budget_status || 'UNKNOWN',
    proposal_id: row.proposal_id,
    content_hash: row.content_hash,
    locked_at: row.locked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function rowToReview(row) {
  if (!row) return null;
  return {
    review_id: row.review_id,
    candidate_id: row.candidate_id,
    commit_sha: row.commit_sha,
    review_status: row.review_status,
    findings: parseJson(row.findings_json, []),
    evidence: parseJson(row.evidence_json, null),
    reviewed_at: row.reviewed_at,
    invalidated_at: row.invalidated_at,
    invalidation_reason: row.invalidation_reason,
  };
}

export function rowToRun(row) {
  if (!row) return null;
  return {
    factory_run_id: row.factory_run_id,
    task_id: row.task_id,
    provider: row.provider,
    provider_run_id: row.provider_run_id,
    provider_agent_id: row.provider_agent_id ?? null,
    attempt: row.attempt,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    failure_class: row.failure_class,
    evidence: parseJson(row.evidence_json, null),
    created_at: row.created_at,
  };
}

export function rowToCandidate(row) {
  if (!row) return null;
  return {
    candidate_id: row.candidate_id,
    task_id: row.task_id,
    factory_run_id: row.factory_run_id,
    provider_run_id: row.provider_run_id ?? null,
    branch: row.branch,
    commit_sha: row.commit_sha,
    pr_number: row.pr_number == null ? null : Number(row.pr_number),
    pr_url: row.pr_url ?? null,
    pr_ref: row.pr_ref,
    verification_ref: row.verification_ref,
    review_ref: row.review_ref,
    ci_status: row.ci_status ?? null,
    ci_conclusion: row.ci_conclusion ?? null,
    ci_ref: row.ci_ref,
    evidence_at: row.evidence_at ?? null,
    status: row.status,
    created_at: row.created_at,
  };
}

export function rowToVerification(row) {
  if (!row) return null;
  return {
    verification_id: row.verification_id,
    candidate_id: row.candidate_id,
    commit_sha: row.commit_sha,
    result: row.result,
    checks: parseJson(row.checks_json, []),
    worker_claim: row.worker_claim,
    failure_class: row.failure_class,
    created_at: row.created_at,
    invalidated_at: row.invalidated_at,
    invalidation_reason: row.invalidation_reason,
  };
}

export function rowToApproval(row) {
  if (!row) return null;
  return {
    approval_id: row.approval_id,
    task_id: row.task_id,
    proposal_id: row.proposal_id,
    content_hash: row.content_hash,
    candidate_id: row.candidate_id,
    commit_sha: row.commit_sha,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    status: row.status,
  };
}

export function rowToEvent(row) {
  if (!row) return null;
  return {
    event_id: row.event_id,
    task_id: row.task_id,
    factory_run_id: row.factory_run_id,
    event_type: row.event_type,
    evidence_ref: row.evidence_ref,
    payload: parseJson(row.payload_json, null),
    timestamp: row.timestamp,
  };
}

export function rowToLease(row) {
  if (!row) return null;
  return {
    lease_key: row.lease_key,
    owner: row.owner,
    fencing_token: Number(row.fencing_token),
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
  };
}

export function nowIso() {
  return new Date().toISOString();
}
