// src/runtime/single-flight.js
// V1.0C Agent 0 single-flight + semantic action dedupe.
//
// Customer-facing decision workflows are single-flight by:
//   tenant_id + subject_ref + routine_id + logical_stage
// Late/duplicate events join the active workflow; they do not spawn competitors.
// Cancelled/expired workflows cannot commit late effects.
// A semantic action key prevents duplicate logical customer effects.
//
// Business-write autonomy remains DISABLED.

import { randomUUID } from 'node:crypto';

export class SingleFlightError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'SingleFlightError';
    this.code = code;
    this.details = details;
  }
}

function requireParts({ subject_ref, routine_id, logical_stage }) {
  if (!subject_ref || !routine_id || !logical_stage) {
    throw new SingleFlightError(
      'INVALID_FLIGHT_KEY',
      'subject_ref, routine_id, and logical_stage are required'
    );
  }
}

async function requireTenant(backend) {
  const r = await backend.query('SELECT cur_tenant() AS t;');
  const t = r.rows[0]?.t;
  if (!t) {
    throw new SingleFlightError('MISSING_TENANT_CONTEXT', 'missing tenant context (fail-closed)');
  }
  return t;
}

/**
 * Acquire (or join) the single active decision flight for the key.
 * Returns { mode: 'acquired'|'joined', flight }.
 * Competing ACTIVE insert is rejected by partial unique index → join path.
 */
export async function acquireOrJoinDecisionFlight(backend, {
  subject_ref,
  routine_id,
  logical_stage,
  workflow_id,
  expires_at = null,
  now = new Date(),
} = {}) {
  requireParts({ subject_ref, routine_id, logical_stage });
  if (!workflow_id) {
    throw new SingleFlightError('INVALID_WORKFLOW', 'workflow_id is required');
  }
  const tenantId = await requireTenant(backend);

  // Expire stale ACTIVE rows whose expires_at has passed (fail-closed fence).
  await backend.query(
    `UPDATE decision_flights
     SET status = 'EXPIRED', completed_at = COALESCE(completed_at, now())
     WHERE tenant_id = cur_tenant()
       AND subject_ref = $1
       AND routine_id = $2
       AND logical_stage = $3
       AND status = 'ACTIVE'
       AND expires_at IS NOT NULL
       AND expires_at < $4;`,
    [subject_ref, routine_id, logical_stage, now.toISOString()]
  );

  const existing = await backend.query(
    `SELECT flight_id, tenant_id, subject_ref, routine_id, logical_stage,
            workflow_id, status, created_at, expires_at, completed_at, cancel_reason
     FROM decision_flights
     WHERE tenant_id = cur_tenant()
       AND subject_ref = $1
       AND routine_id = $2
       AND logical_stage = $3
       AND status = 'ACTIVE'
     LIMIT 1;`,
    [subject_ref, routine_id, logical_stage]
  );
  if (existing.rows[0]) {
    const flight = existing.rows[0];
    return {
      mode: flight.workflow_id === workflow_id ? 'acquired' : 'joined',
      flight,
      competing: flight.workflow_id !== workflow_id,
    };
  }

  const flightId = randomUUID();
  try {
    await backend.query('SAVEPOINT sp_decision_flight;');
    await backend.query(
      `INSERT INTO decision_flights (
         flight_id, tenant_id, subject_ref, routine_id, logical_stage,
         workflow_id, status, expires_at
       ) VALUES ($1, cur_tenant(), $2, $3, $4, $5, 'ACTIVE', $6);`,
      [flightId, subject_ref, routine_id, logical_stage, workflow_id, expires_at]
    );
    await backend.query('RELEASE SAVEPOINT sp_decision_flight;');
  } catch (err) {
    await backend.query('ROLLBACK TO SAVEPOINT sp_decision_flight;').catch(() => {});
    // Race: another worker acquired first — join that flight.
    const raced = await backend.query(
      `SELECT flight_id, tenant_id, subject_ref, routine_id, logical_stage,
              workflow_id, status, created_at, expires_at, completed_at, cancel_reason
       FROM decision_flights
       WHERE tenant_id = cur_tenant()
         AND subject_ref = $1
         AND routine_id = $2
         AND logical_stage = $3
         AND status = 'ACTIVE'
       LIMIT 1;`,
      [subject_ref, routine_id, logical_stage]
    );
    if (raced.rows[0]) {
      const flight = raced.rows[0];
      return {
        mode: flight.workflow_id === workflow_id ? 'acquired' : 'joined',
        flight,
        competing: flight.workflow_id !== workflow_id,
      };
    }
    throw err;
  }

  const created = await backend.query(
    `SELECT flight_id, tenant_id, subject_ref, routine_id, logical_stage,
            workflow_id, status, created_at, expires_at, completed_at, cancel_reason
     FROM decision_flights WHERE flight_id = $1;`,
    [flightId]
  );
  return { mode: 'acquired', flight: created.rows[0], competing: false };
}

export async function cancelDecisionFlight(backend, {
  workflow_id,
  reason = 'cancelled',
} = {}) {
  if (!workflow_id) {
    throw new SingleFlightError('INVALID_WORKFLOW', 'workflow_id is required');
  }
  await requireTenant(backend);
  const r = await backend.query(
    `UPDATE decision_flights
     SET status = 'CANCELLED',
         completed_at = now(),
         cancel_reason = $2
     WHERE tenant_id = cur_tenant()
       AND workflow_id = $1
       AND status = 'ACTIVE'
     RETURNING flight_id, workflow_id, status, cancel_reason;`,
    [workflow_id, reason]
  );
  return r.rows[0] ?? null;
}

export async function completeDecisionFlight(backend, { workflow_id } = {}) {
  if (!workflow_id) {
    throw new SingleFlightError('INVALID_WORKFLOW', 'workflow_id is required');
  }
  await requireTenant(backend);
  const r = await backend.query(
    `UPDATE decision_flights
     SET status = 'COMPLETED', completed_at = now()
     WHERE tenant_id = cur_tenant()
       AND workflow_id = $1
       AND status = 'ACTIVE'
     RETURNING flight_id, workflow_id, status;`,
    [workflow_id]
  );
  return r.rows[0] ?? null;
}

/**
 * Fail-closed commit fence: cancelled/expired flights cannot authorize effects.
 * When requireActiveFlight is true (V1.0C enforce path), missing flight DENYs.
 * Binding fields must match the ACTIVE flight when provided; when requireActiveFlight
 * is true they are mandatory.
 */
export async function assertWorkflowMayCommitEffect(backend, {
  workflow_id,
  subject_ref = null,
  routine_id = null,
  logical_stage = null,
  requireActiveFlight = false,
  now = new Date(),
} = {}) {
  if (!workflow_id) {
    throw new SingleFlightError('INVALID_WORKFLOW', 'workflow_id is required');
  }
  await requireTenant(backend);

  await backend.query(
    `UPDATE decision_flights
     SET status = 'EXPIRED', completed_at = COALESCE(completed_at, now())
     WHERE tenant_id = cur_tenant()
       AND workflow_id = $1
       AND status = 'ACTIVE'
       AND expires_at IS NOT NULL
       AND expires_at < $2;`,
    [workflow_id, now.toISOString()]
  );

  const r = await backend.query(
    `SELECT flight_id, tenant_id, subject_ref, routine_id, logical_stage,
            workflow_id, status, created_at, expires_at, completed_at, cancel_reason
     FROM decision_flights
     WHERE tenant_id = cur_tenant()
       AND workflow_id = $1
     ORDER BY created_at DESC
     LIMIT 1;`,
    [workflow_id]
  );
  const flight = r.rows[0];
  if (!flight) {
    if (requireActiveFlight) {
      throw new SingleFlightError(
        'FLIGHT_REQUIRED',
        'enforce_single_flight requires an ACTIVE decision flight for this workflow',
        { workflow_id }
      );
    }
    return { allowed: true, flight: null, fence_engaged: false };
  }
  if (flight.status === 'CANCELLED') {
    throw new SingleFlightError(
      'WORKFLOW_CANCELLED',
      'cancelled workflow cannot commit late effect',
      { workflow_id, status: flight.status }
    );
  }
  if (flight.status === 'EXPIRED') {
    throw new SingleFlightError(
      'WORKFLOW_EXPIRED',
      'expired workflow cannot commit late effect',
      { workflow_id, status: flight.status }
    );
  }
  if (flight.status !== 'ACTIVE') {
    throw new SingleFlightError(
      'WORKFLOW_NOT_ACTIVE',
      `workflow status ${flight.status} cannot commit effect`,
      { workflow_id, status: flight.status }
    );
  }
  if (requireActiveFlight) {
    if (!subject_ref || !routine_id || !logical_stage) {
      throw new SingleFlightError(
        'FLIGHT_BINDING_REQUIRED',
        'enforce_single_flight requires subject_ref, routine_id, and logical_stage',
        { workflow_id }
      );
    }
  }
  if (subject_ref && flight.subject_ref !== subject_ref) {
    throw new SingleFlightError('FLIGHT_SUBJECT_MISMATCH', 'subject_ref does not match active flight');
  }
  if (routine_id && flight.routine_id !== routine_id) {
    throw new SingleFlightError('FLIGHT_ROUTINE_MISMATCH', 'routine_id does not match active flight');
  }
  if (logical_stage && flight.logical_stage !== logical_stage) {
    throw new SingleFlightError('FLIGHT_STAGE_MISMATCH', 'logical_stage does not match active flight');
  }
  return { allowed: true, flight, fence_engaged: true };
}

/**
 * Claim a semantic action key. Second claim for same tenant+subject+key fails closed.
 */
export async function claimSemanticAction(backend, {
  subject_ref,
  semantic_action_key,
  workflow_id,
  effect_id = null,
} = {}) {
  if (!subject_ref || !semantic_action_key || !workflow_id) {
    throw new SingleFlightError(
      'INVALID_SEMANTIC_CLAIM',
      'subject_ref, semantic_action_key, and workflow_id are required'
    );
  }
  await requireTenant(backend);
  const claimId = randomUUID();

  const existing = await backend.query(
    `SELECT claim_id, workflow_id, effect_id, claimed_at
     FROM semantic_action_claims
     WHERE tenant_id = cur_tenant()
       AND subject_ref = $1
       AND semantic_action_key = $2;`,
    [subject_ref, semantic_action_key]
  );
  if (existing.rows[0]) {
    const prior = existing.rows[0];
    if (prior.workflow_id === workflow_id) {
      return { claimed: true, duplicate: true, claim: prior };
    }
    throw new SingleFlightError(
      'SEMANTIC_ACTION_DUPLICATE',
      'semantic action key already claimed by another workflow',
      { prior_workflow_id: prior.workflow_id, semantic_action_key }
    );
  }

  try {
    await backend.query('SAVEPOINT sp_semantic_claim;');
    await backend.query(
      `INSERT INTO semantic_action_claims (
         claim_id, tenant_id, subject_ref, semantic_action_key, workflow_id, effect_id
       ) VALUES ($1, cur_tenant(), $2, $3, $4, $5);`,
      [claimId, subject_ref, semantic_action_key, workflow_id, effect_id]
    );
    await backend.query('RELEASE SAVEPOINT sp_semantic_claim;');
  } catch (err) {
    await backend.query('ROLLBACK TO SAVEPOINT sp_semantic_claim;').catch(() => {});
    const raced = await backend.query(
      `SELECT claim_id, workflow_id, effect_id, claimed_at
       FROM semantic_action_claims
       WHERE tenant_id = cur_tenant()
         AND subject_ref = $1
         AND semantic_action_key = $2;`,
      [subject_ref, semantic_action_key]
    );
    if (raced.rows[0]) {
      const prior = raced.rows[0];
      if (prior.workflow_id === workflow_id) {
        return { claimed: true, duplicate: true, claim: prior };
      }
      throw new SingleFlightError(
        'SEMANTIC_ACTION_DUPLICATE',
        'semantic action key already claimed by another workflow',
        { prior_workflow_id: prior.workflow_id, semantic_action_key }
      );
    }
    throw err;
  }
  const created = await backend.query(
    `SELECT claim_id, workflow_id, effect_id, claimed_at
     FROM semantic_action_claims WHERE claim_id = $1;`,
    [claimId]
  );
  return { claimed: true, duplicate: false, claim: created.rows[0] };
}

/** Release a provisional semantic claim after failed/denied commit (anti-griefing). */
export async function releaseSemanticActionClaim(backend, {
  subject_ref,
  semantic_action_key,
  workflow_id,
} = {}) {
  if (!subject_ref || !semantic_action_key || !workflow_id) return null;
  await requireTenant(backend);
  const r = await backend.query(
    `DELETE FROM semantic_action_claims
     WHERE tenant_id = cur_tenant()
       AND subject_ref = $1
       AND semantic_action_key = $2
       AND workflow_id = $3
     RETURNING claim_id;`,
    [subject_ref, semantic_action_key, workflow_id]
  );
  return r.rows[0] ?? null;
}
