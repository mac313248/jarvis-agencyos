// src/contracts/approval.js
// ApprovalDecision binding primitive per 06_SYSTEM_CONTRACTS.md and
// 05_PRODUCT_BEHAVIOR.md / 07_AUTHORITY_SECURITY_EXECUTION.md.
//
// High-risk approval requires:
//   - an authenticated, non-expired owner session
//   - auth_strength = step_up_mfa
//   - unexpired step_up (step_up_expires_at > now)
//   - exact binding to proposal_id + request_hash
//   - matching relevant_state_version / policy_version where applicable
//
// An approval is INVALID if the proposal/request/state binding no longer matches.
// Raw text claiming approval has zero authorization value (returns invalid).

export class ApprovalError extends Error {
  constructor(reason) { super(`invalid approval: ${reason}`); this.name = 'ApprovalError'; this.reason = reason; }
}

// Load an owner session row. Returns null if not found.
export async function loadOwnerSession(backend, sessionId) {
  const r = await backend.query(
    `SELECT session_id, owner_principal_id, auth_strength, authenticated_at,
            step_up_verified_at, step_up_expires_at, session_expires_at, revoked_at
     FROM owner_sessions WHERE session_id = $1;`,
    [sessionId]
  );
  return r.rows[0] ?? null;
}

// Load an action proposal row.
export async function loadProposal(backend, proposalId) {
  const r = await backend.query(
    `SELECT proposal_id, tenant_id, workflow_id, step_id, capability_id,
            request_hash, risk_class, reversibility, expires_at
     FROM action_proposals WHERE proposal_id = $1;`,
    [proposalId]
  );
  return r.rows[0] ?? null;
}

// Load an approval decision row.
export async function loadApproval(backend, approvalId) {
  const r = await backend.query(
    `SELECT approval_id, proposal_id, request_hash, tenant_id, owner_principal_id,
            owner_auth_session_id, step_up_mfa_required, decision,
            relevant_state_version, policy_version, decided_at, expires_at, consumed_at
     FROM approval_decisions WHERE approval_id = $1;`,
    [approvalId]
  );
  return r.rows[0] ?? null;
}

// Validate that a stored approval is currently usable for a given proposal.
// Returns { valid: boolean, reasons: string[] }.
export function validateApproval({ approval, proposal, session, now = Date.now() }) {
  const reasons = [];
  if (!approval) { return { valid: false, reasons: ['no approval record'] }; }
  if (!proposal) { return { valid: false, reasons: ['no proposal record'] }; }
  if (approval.decision !== 'APPROVE') reasons.push('decision is not APPROVE');
  if (approval.consumed_at) reasons.push('approval already consumed');
  if (approval.expires_at && new Date(approval.expires_at).getTime() < now) reasons.push('approval expired');
  // Exact binding: proposal_id
  if (approval.proposal_id !== proposal.proposal_id) reasons.push('proposal_id mismatch');
  // Exact binding: request_hash
  if (approval.request_hash !== proposal.request_hash) reasons.push('request_hash mismatch');
  // State/version binding invalidation (when contract requires it)
  if (approval.relevant_state_version != null && proposal.precondition_snapshot_ref != null
      && approval.relevant_state_version !== proposal.precondition_snapshot_ref) {
    reasons.push('relevant_state_version no longer matches proposal state');
  }
  // High-risk requires recent, unexpired step-up MFA.
  if (approval.step_up_mfa_required) {
    if (!session) { reasons.push('no owner session'); }
    else {
      if (session.revoked_at) reasons.push('session revoked');
      if (new Date(session.session_expires_at).getTime() < now) reasons.push('session expired');
      if (session.auth_strength !== 'step_up_mfa') reasons.push('auth_strength not step_up_mfa');
      if (!session.step_up_expires_at) reasons.push('no step-up expiry recorded');
      else if (new Date(session.step_up_expires_at).getTime() < now) reasons.push('step-up MFA expired');
      if (!session.step_up_verified_at) reasons.push('step-up MFA never verified');
    }
  }
  return { valid: reasons.length === 0, reasons };
}

// Convenience: a raw text claim ("owner approved") has no authorization value.
// This function exists to make the negative test explicit: it always returns
// invalid and never consults any text blob.
export function evaluateRawTextApproval(_rawText) {
  return { valid: false, reasons: ['raw text approval has zero authorization value'] };
}
