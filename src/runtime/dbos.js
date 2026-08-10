// src/runtime/dbos.js
// F-09: DBOS Transact + Postgres durable workflows.
//
// Implements DBOS Transact semantics on Postgres (SOT
// 08_RUNTIME_WORKFLOWS_SPECIALISTS.md#DURABLE-WORKFLOWS):
//   - every nondeterministic LLM/tool/external interaction is a durable step
//   - completed steps checkpoint to Postgres and are never re-executed on recovery
//   - approval waits survive process restart
//   - restore freezes writers until Postgres/DBOS/providers reconcile
//
// Schema/role separation: workflow system state lives in schema `dbos` under
// role `dbos_runtime` (07_AUTHORITY_SECURITY_EXECUTION.md).
// NON-SCOPE: Temporal/Restate, business-write autonomy (remains DISABLED).

import { randomUUID } from 'node:crypto';
import { asRole } from '../db/index.js';
import {
  assertBusinessWriteAutonomyDisabled,
  BUSINESS_WRITE_AUTONOMY,
} from './autonomy.js';

export const DBOS_SCHEMA = 'dbos';
export const DBOS_ROLE = 'dbos_runtime';

export class DbosError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'DbosError';
    this.code = code;
    this.details = details;
  }
}

export class WritersFrozenError extends DbosError {
  constructor(message = 'writers frozen until Postgres/DBOS/providers reconcile') {
    super('WRITERS_FROZEN', message);
    this.name = 'WritersFrozenError';
  }
}

function jsonClone(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

async function withDbosRole(db, fn) {
  return asRole(db, DBOS_ROLE, fn);
}

async function loadWorkflow(backend, workflowId) {
  const r = await backend.query(
    `SELECT workflow_id, workflow_name, tenant_id, status, input_json, output_json,
            error_json, next_function_id, created_at, updated_at
       FROM dbos.workflows WHERE workflow_id = $1;`,
    [workflowId]
  );
  return r.rows[0] || null;
}

async function loadStep(backend, workflowId, stepId) {
  const r = await backend.query(
    `SELECT workflow_id, function_id, step_id, step_kind, status, output_json, error_json, completed_at
       FROM dbos.operation_outputs
      WHERE workflow_id = $1 AND step_id = $2;`,
    [workflowId, stepId]
  );
  return r.rows[0] || null;
}

async function loadWait(backend, workflowId, stepId) {
  const r = await backend.query(
    `SELECT wait_id, workflow_id, step_id, proposal_id, status, signal_payload, created_at, signaled_at
       FROM dbos.approval_waits
      WHERE workflow_id = $1 AND step_id = $2;`,
    [workflowId, stepId]
  );
  return r.rows[0] || null;
}

async function readRecovery(backend) {
  const r = await backend.query(
    `SELECT writers_frozen, recovery_epoch, postgres_reconciled, dbos_reconciled,
            providers_reconciled, updated_at
       FROM recovery_control WHERE control_id = 1;`
  );
  const row = r.rows[0];
  if (!row) {
    throw new DbosError('RECOVERY_CONTROL_MISSING', 'recovery_control singleton missing (fail-closed)');
  }
  return row;
}

/**
 * Fail-closed gate for material writers during restore/PITR.
 * Call before any AgencyOS write that must respect recovery freeze.
 */
export async function assertWritersAllowed(backend) {
  const state = await readRecovery(backend);
  if (state.writers_frozen) {
    throw new WritersFrozenError();
  }
  return state;
}

/**
 * Create a DBOS Transact-style durable runtime bound to this Postgres backend.
 * Process restart = new runtime instance against the same durable tables.
 */
export function createDbosRuntime(db, { role = DBOS_ROLE } = {}) {
  assertBusinessWriteAutonomyDisabled();
  if (BUSINESS_WRITE_AUTONOMY !== false) {
    throw new DbosError('AUTONOMY_ENABLED', 'BUSINESS_WRITE_AUTONOMY must remain DISABLED');
  }

  const registry = new Map(); // workflow_name -> async fn(ctx, input)

  function registerWorkflow(name, fn) {
    if (typeof name !== 'string' || !name) {
      throw new DbosError('INVALID_WORKFLOW_NAME', 'workflow name required');
    }
    if (typeof fn !== 'function') {
      throw new DbosError('INVALID_WORKFLOW_FN', 'workflow function required');
    }
    registry.set(name, fn);
    return name;
  }

  async function startWorkflow(name, input = {}, { workflowId = randomUUID(), tenantId = null } = {}) {
    if (!registry.has(name)) {
      throw new DbosError('UNKNOWN_WORKFLOW', `workflow not registered: ${name}`);
    }
    await withDbosRole(db, async (backend) => {
      const existing = await loadWorkflow(backend, workflowId);
      if (existing) {
        throw new DbosError('WORKFLOW_EXISTS', `workflow already exists: ${workflowId}`);
      }
      await backend.query(
        `INSERT INTO dbos.workflows
           (workflow_id, workflow_name, tenant_id, status, input_json, next_function_id)
         VALUES ($1, $2, $3, 'PENDING', $4::jsonb, 0);`,
        [workflowId, name, tenantId, JSON.stringify(jsonClone(input) ?? {})]
      );
    });
    return resumeWorkflow(workflowId);
  }

  async function makeContext(backend, workflow) {
    let functionIdCursor = workflow.next_function_id;

    async function allocateFunctionId(stepId) {
      const existing = await loadStep(backend, workflow.workflow_id, stepId);
      if (existing) return { existing, functionId: existing.function_id };
      const functionId = functionIdCursor;
      functionIdCursor += 1;
      await backend.query(
        `UPDATE dbos.workflows
            SET next_function_id = $2, updated_at = now()
          WHERE workflow_id = $1;`,
        [workflow.workflow_id, functionIdCursor]
      );
      return { existing: null, functionId };
    }

    async function runStep(stepId, fn, { kind = 'STEP' } = {}) {
      if (typeof stepId !== 'string' || !stepId) {
        throw new DbosError('INVALID_STEP_ID', 'step_id required');
      }
      if (typeof fn !== 'function') {
        throw new DbosError('INVALID_STEP_FN', 'step function required');
      }

      const { existing, functionId } = await allocateFunctionId(stepId);
      if (existing) {
        if (existing.status === 'ERROR') {
          const err = new DbosError('STEP_PREVIOUSLY_FAILED', `step ${stepId} previously failed`);
          err.causePayload = existing.error_json;
          throw err;
        }
        return existing.output_json;
      }

      // Nondeterministic work runs only when no checkpoint exists.
      let output;
      try {
        output = await fn();
      } catch (e) {
        await backend.query(
          `INSERT INTO dbos.operation_outputs
             (workflow_id, function_id, step_id, step_kind, status, error_json)
           VALUES ($1, $2, $3, $4, 'ERROR', $5::jsonb);`,
          [
            workflow.workflow_id,
            functionId,
            stepId,
            kind,
            JSON.stringify({ message: e.message, name: e.name }),
          ]
        );
        throw e;
      }

      const stored = jsonClone(output);
      await backend.query(
        `INSERT INTO dbos.operation_outputs
           (workflow_id, function_id, step_id, step_kind, status, output_json)
         VALUES ($1, $2, $3, $4, 'SUCCESS', $5::jsonb);`,
        [workflow.workflow_id, functionId, stepId, kind, JSON.stringify(stored)]
      );
      return stored;
    }

    /**
     * Durable approval wait. Survives restart: WAITING rows persist; SIGNALED
     * payloads are returned from checkpoint without re-waiting.
     */
    async function waitForApproval(stepId, { proposalId = null } = {}) {
      const prior = await loadStep(backend, workflow.workflow_id, stepId);
      if (prior?.status === 'SUCCESS') {
        return prior.output_json;
      }
      if (prior?.status === 'ERROR') {
        throw new DbosError('STEP_PREVIOUSLY_FAILED', `approval step ${stepId} previously failed`);
      }

      let wait = await loadWait(backend, workflow.workflow_id, stepId);
      if (!wait) {
        const waitId = randomUUID();
        await backend.query(
          `INSERT INTO dbos.approval_waits
             (wait_id, workflow_id, step_id, proposal_id, status)
           VALUES ($1, $2, $3, $4, 'WAITING');`,
          [waitId, workflow.workflow_id, stepId, proposalId]
        );
        await backend.query(
          `UPDATE dbos.workflows
              SET status = 'WAITING', updated_at = now()
            WHERE workflow_id = $1;`,
          [workflow.workflow_id]
        );
        wait = await loadWait(backend, workflow.workflow_id, stepId);
      }

      if (wait.status === 'WAITING') {
        await backend.query(
          `UPDATE dbos.workflows
              SET status = 'WAITING', updated_at = now()
            WHERE workflow_id = $1;`,
          [workflow.workflow_id]
        );
        const err = new DbosError('APPROVAL_WAIT', `workflow waiting on approval step ${stepId}`, {
          workflow_id: workflow.workflow_id,
          step_id: stepId,
          wait_id: wait.wait_id,
          proposal_id: wait.proposal_id,
        });
        err.code = 'APPROVAL_WAIT';
        throw err;
      }

      if (wait.status !== 'SIGNALED') {
        throw new DbosError('WAIT_CANCELLED', `approval wait ${stepId} is ${wait.status}`);
      }

      // Checkpoint the signaled payload as a completed durable step (OAOO).
      return runStep(stepId, async () => wait.signal_payload ?? {}, { kind: 'APPROVAL_WAIT' });
    }

    return {
      workflowId: workflow.workflow_id,
      workflowName: workflow.workflow_name,
      tenantId: workflow.tenant_id,
      input: workflow.input_json,
      runStep,
      waitForApproval,
    };
  }

  async function resumeWorkflow(workflowId) {
    return withDbosRole(db, async (backend) => {
      const workflow = await loadWorkflow(backend, workflowId);
      if (!workflow) {
        throw new DbosError('WORKFLOW_NOT_FOUND', `workflow not found: ${workflowId}`);
      }
      if (workflow.status === 'SUCCESS' || workflow.status === 'CANCELLED') {
        return {
          status: workflow.status,
          workflow_id: workflowId,
          output: workflow.output_json,
          error: workflow.error_json,
        };
      }
      if (workflow.status === 'ERROR') {
        return {
          status: 'ERROR',
          workflow_id: workflowId,
          output: null,
          error: workflow.error_json,
        };
      }

      const fn = registry.get(workflow.workflow_name);
      if (!fn) {
        throw new DbosError(
          'WORKFLOW_NOT_REGISTERED',
          `cannot recover ${workflow.workflow_name}: not registered in this process`
        );
      }

      // Re-enter PENDING while replaying; WAITING is re-asserted by waitForApproval.
      if (workflow.status === 'WAITING') {
        await backend.query(
          `UPDATE dbos.workflows SET status = 'PENDING', updated_at = now() WHERE workflow_id = $1;`,
          [workflowId]
        );
        workflow.status = 'PENDING';
      }

      const ctx = await makeContext(backend, workflow);
      try {
        const output = await fn(ctx, workflow.input_json);
        const stored = jsonClone(output);
        await backend.query(
          `UPDATE dbos.workflows
              SET status = 'SUCCESS', output_json = $2::jsonb, error_json = NULL, updated_at = now()
            WHERE workflow_id = $1;`,
          [workflowId, JSON.stringify(stored)]
        );
        return { status: 'SUCCESS', workflow_id: workflowId, output: stored, error: null };
      } catch (e) {
        if (e instanceof DbosError && e.code === 'APPROVAL_WAIT') {
          return {
            status: 'WAITING',
            workflow_id: workflowId,
            output: null,
            error: null,
            wait: e.details,
          };
        }
        await backend.query(
          `UPDATE dbos.workflows
              SET status = 'ERROR', error_json = $2::jsonb, updated_at = now()
            WHERE workflow_id = $1;`,
          [workflowId, JSON.stringify({ message: e.message, name: e.name, code: e.code || null })]
        );
        return {
          status: 'ERROR',
          workflow_id: workflowId,
          output: null,
          error: { message: e.message, name: e.name, code: e.code || null },
        };
      }
    });
  }

  async function signalApproval(workflowId, stepId, payload = {}) {
    return withDbosRole(db, async (backend) => {
      const wait = await loadWait(backend, workflowId, stepId);
      if (!wait) {
        throw new DbosError('WAIT_NOT_FOUND', `no approval wait for ${workflowId}/${stepId}`);
      }
      if (wait.status === 'SIGNALED') {
        return { status: 'SIGNALED', wait_id: wait.wait_id, duplicate: true };
      }
      if (wait.status !== 'WAITING') {
        throw new DbosError('WAIT_NOT_WAITING', `wait status is ${wait.status}`);
      }
      await backend.query(
        `UPDATE dbos.approval_waits
            SET status = 'SIGNALED', signal_payload = $3::jsonb, signaled_at = now()
          WHERE workflow_id = $1 AND step_id = $2;`,
        [workflowId, stepId, JSON.stringify(jsonClone(payload) ?? {})]
      );
      await backend.query(
        `UPDATE dbos.workflows
            SET status = 'PENDING', updated_at = now()
          WHERE workflow_id = $1 AND status = 'WAITING';`,
        [workflowId]
      );
      return { status: 'SIGNALED', wait_id: wait.wait_id, duplicate: false };
    });
  }

  async function listCompletedSteps(workflowId) {
    return withDbosRole(db, async (backend) => {
      const r = await backend.query(
        `SELECT function_id, step_id, step_kind, status, output_json, completed_at
           FROM dbos.operation_outputs
          WHERE workflow_id = $1
          ORDER BY function_id ASC;`,
        [workflowId]
      );
      return r.rows;
    });
  }

  async function getWorkflow(workflowId) {
    return withDbosRole(db, async (backend) => loadWorkflow(backend, workflowId));
  }

  // --- Restore / PITR writer freeze (#52) ---

  async function beginRestore() {
    return withDbosRole(db, async (backend) => {
      const prior = await readRecovery(backend);
      const nextEpoch = Number(prior.recovery_epoch) + 1;
      await backend.query(
        `UPDATE recovery_control SET
           writers_frozen = true,
           recovery_epoch = $1,
           postgres_reconciled = false,
           dbos_reconciled = false,
           providers_reconciled = false,
           updated_at = now()
         WHERE control_id = 1;`,
        [nextEpoch]
      );
      return readRecovery(backend);
    });
  }

  async function markReconciled(surface) {
    const col = {
      postgres: 'postgres_reconciled',
      dbos: 'dbos_reconciled',
      providers: 'providers_reconciled',
    }[surface];
    if (!col) {
      throw new DbosError('UNKNOWN_RECONCILE_SURFACE', `unknown surface: ${surface}`);
    }
    return withDbosRole(db, async (backend) => {
      const state = await readRecovery(backend);
      if (!state.writers_frozen) {
        throw new DbosError('NOT_IN_RESTORE', 'markReconciled requires an active restore freeze');
      }
      await backend.query(
        `UPDATE recovery_control SET ${col} = true, updated_at = now() WHERE control_id = 1;`
      );
      return readRecovery(backend);
    });
  }

  /**
   * Re-enable writers only after Postgres + DBOS + providers reconcile.
   * Premature thaw is refused (stop condition).
   */
  async function completeRestore() {
    return withDbosRole(db, async (backend) => {
      const state = await readRecovery(backend);
      if (!state.writers_frozen) {
        return { ...state, already_open: true };
      }
      const missing = [];
      if (!state.postgres_reconciled) missing.push('postgres');
      if (!state.dbos_reconciled) missing.push('dbos');
      if (!state.providers_reconciled) missing.push('providers');
      if (missing.length) {
        throw new DbosError(
          'RECONCILE_INCOMPLETE',
          `cannot reactivate writers before reconciliation: missing ${missing.join(',')}`,
          { missing }
        );
      }
      await backend.query(
        `UPDATE recovery_control SET writers_frozen = false, updated_at = now() WHERE control_id = 1;`
      );
      return readRecovery(backend);
    });
  }

  async function getRecoveryState() {
    return withDbosRole(db, async (backend) => readRecovery(backend));
  }

  return {
    registerWorkflow,
    startWorkflow,
    resumeWorkflow,
    signalApproval,
    listCompletedSteps,
    getWorkflow,
    beginRestore,
    markReconciled,
    completeRestore,
    getRecoveryState,
    assertWritersAllowed: () => assertWritersAllowed(db),
  };
}
