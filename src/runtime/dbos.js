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
// Tenant scope comes from trusted transaction-local context (cur_tenant()),
// never from caller/model-selected nullable tenant arguments.
// External/tool/LLM steps bind to the deterministic idempotency key +
// postcondition path shared with trusted-executor (06_SYSTEM_CONTRACTS.md).
// NON-SCOPE: Temporal/Restate, business-write autonomy (remains DISABLED).

import { randomUUID } from 'node:crypto';
import { asRole } from '../db/index.js';
import { idempotencyKey, requestHash } from '../contracts/ids.js';
import {
  assertBusinessWriteAutonomyDisabled,
  BUSINESS_WRITE_AUTONOMY,
  LIVE_EXTERNAL_SIDE_EFFECTS,
} from './autonomy.js';
import { LOCAL_FAKE_SURFACE } from './local-effect-adapter.js';

export const DBOS_SCHEMA = 'dbos';
export const DBOS_ROLE = 'dbos_runtime';

/** Step kinds that perform nondeterministic external/tool/LLM side effects. */
export const EFFECT_BOUND_STEP_KINDS = Object.freeze(['EXTERNAL', 'TOOL', 'LLM']);

/** Non-terminal postcondition statuses that stay recoverable for reconciliation. */
export const RECOVERABLE_POSTCONDITION_STATUSES = Object.freeze(['UNKNOWN', 'AMBIGUOUS']);

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

/** External effect committed but step checkpoint not durable yet — resume must not re-commit. */
export class CrashAfterEffectCommitError extends DbosError {
  constructor(message, details = null) {
    super('CRASH_AFTER_EFFECT_COMMIT', message, details);
    this.name = 'CrashAfterEffectCommitError';
  }
}

/** Effect committed but postcondition UNKNOWN/AMBIGUOUS — recoverable, never SUCCEEDED. */
export class AmbiguousPostconditionError extends DbosError {
  constructor(message, details = null) {
    const status = details?.postcondition_status === 'UNKNOWN' ? 'UNKNOWN' : 'AMBIGUOUS';
    super(
      status === 'UNKNOWN' ? 'EFFECT_POSTCONDITION_UNKNOWN' : 'EFFECT_POSTCONDITION_AMBIGUOUS',
      message,
      details
    );
    this.name = 'AmbiguousPostconditionError';
    this.postcondition_status = status;
  }
}

function jsonClone(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function requiresEffectBinding(kind) {
  return EFFECT_BOUND_STEP_KINDS.includes(kind);
}

async function withDbosRole(db, fn) {
  return asRole(db, DBOS_ROLE, fn);
}

async function requireTrustedTenant(backend) {
  const r = await backend.query('SELECT require_tenant() AS t;');
  const t = r.rows[0]?.t;
  if (!t) {
    throw new DbosError('MISSING_TENANT_CONTEXT', 'missing tenant context (fail-closed)');
  }
  return t;
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
    `SELECT workflow_id, tenant_id, function_id, step_id, step_kind, status,
            output_json, error_json, idempotency_key, completed_at
       FROM dbos.operation_outputs
      WHERE workflow_id = $1 AND step_id = $2;`,
    [workflowId, stepId]
  );
  return r.rows[0] || null;
}

async function loadWait(backend, workflowId, stepId) {
  const r = await backend.query(
    `SELECT wait_id, workflow_id, tenant_id, step_id, proposal_id, status,
            signal_payload, created_at, signaled_at
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
 *
 * @param {object} db
 * @param {{ trustedTenantId: string }} opts - tenant MUST come from trusted
 *   infrastructure identity, never from model/client-selected scope.
 */
export function createDbosRuntime(db, { trustedTenantId } = {}) {
  assertBusinessWriteAutonomyDisabled();
  if (BUSINESS_WRITE_AUTONOMY !== false) {
    throw new DbosError('AUTONOMY_ENABLED', 'BUSINESS_WRITE_AUTONOMY must remain DISABLED');
  }
  if (!trustedTenantId) {
    throw new DbosError(
      'MISSING_TENANT_CONTEXT',
      'createDbosRuntime requires trustedTenantId from trusted infrastructure (fail-closed)'
    );
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

  /**
   * Run fn as dbos_runtime inside a transaction with trusted tenant context set.
   * Tenant is fixed at runtime construction — never taken from call arguments.
   */
  async function withTrustedTenantTx(fn) {
    return withDbosRole(db, async (backend) => {
      return backend.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [trustedTenantId]);
        await requireTrustedTenant(tx);
        return fn(tx);
      });
    });
  }

  /** Control-plane recovery_control access (singleton; not tenant-owned). */
  async function withRecoveryTx(fn) {
    return withDbosRole(db, async (backend) => {
      return backend.tx(async (tx) => fn(tx));
    });
  }

  async function startWorkflow(name, input = {}, options = {}) {
    if (!registry.has(name)) {
      throw new DbosError('UNKNOWN_WORKFLOW', `workflow not registered: ${name}`);
    }
    if (options && Object.prototype.hasOwnProperty.call(options, 'tenantId')) {
      throw new DbosError(
        'CALLER_TENANT_SCOPE_FORBIDDEN',
        'startWorkflow must not accept caller-selected tenantId; use trusted runtime tenant context'
      );
    }
    const workflowId = options.workflowId || randomUUID();

    await withTrustedTenantTx(async (backend) => {
      await assertWritersAllowed(backend);
      const tenantId = await requireTrustedTenant(backend);
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
    const tenantId = workflow.tenant_id;

    async function allocateFunctionId(stepId) {
      const existing = await loadStep(backend, workflow.workflow_id, stepId);
      if (existing) return { existing, functionId: existing.function_id };
      // Writer-freeze gate before every DBOS mutation (including next_function_id).
      await assertWritersAllowed(backend);
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

    async function checkpointStep({
      functionId,
      stepId,
      kind,
      status,
      output = null,
      error = null,
      effectKey = null,
    }) {
      await assertWritersAllowed(backend);
      await backend.query(
        `INSERT INTO dbos.operation_outputs
           (workflow_id, tenant_id, function_id, step_id, step_kind, status,
            output_json, error_json, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
         ON CONFLICT (workflow_id, step_id) DO UPDATE SET
           status = EXCLUDED.status,
           output_json = EXCLUDED.output_json,
           error_json = EXCLUDED.error_json,
           idempotency_key = COALESCE(EXCLUDED.idempotency_key, operation_outputs.idempotency_key),
           completed_at = now();`,
        [
          workflow.workflow_id,
          tenantId,
          functionId,
          stepId,
          kind,
          status,
          output === null ? null : JSON.stringify(output),
          error === null ? null : JSON.stringify(error),
          effectKey,
        ]
      );
    }

    function assertApprovedDisabledEffectBoundary(adapter) {
      assertBusinessWriteAutonomyDisabled();
      if (LIVE_EXTERNAL_SIDE_EFFECTS !== false) {
        throw new DbosError(
          'LIVE_EXTERNAL_FORBIDDEN',
          'LIVE_EXTERNAL_SIDE_EFFECTS must remain false; live effect adapters are forbidden'
        );
      }
      if (!adapter || adapter.surface !== LOCAL_FAKE_SURFACE) {
        throw new DbosError(
          'LIVE_EXTERNAL_FORBIDDEN',
          'DBOS effect-bound steps may only execute the approved disabled local_fake boundary'
        );
      }
    }

    async function resumeAmbiguousEffectStep({
      existing,
      stepId,
      kind,
      adapter,
      key,
      functionId,
    }) {
      assertApprovedDisabledEffectBoundary(adapter);
      if (!adapter.hasCommitted(key)) {
        throw new DbosError(
          'EFFECT_AMBIGUOUS_MISSING_COMMIT',
          `ambiguous step ${stepId} has no committed effect to reconcile (fail-closed)`,
          { idempotency_key: key, prior_status: existing.status }
        );
      }
      const post = await adapter.verifyPostcondition({ idempotency_key: key });
      if (post.status === 'VERIFIED') {
        const recovered = {
          ok: true,
          resumed: true,
          reconciled: true,
          idempotency_key: key,
          commit_token: adapter.getCommitted?.(key)?.commit_token ?? null,
          postcondition_status: post.status,
        };
        await checkpointStep({
          functionId,
          stepId,
          kind,
          status: 'SUCCESS',
          output: recovered,
          effectKey: key,
        });
        return recovered;
      }
      if (RECOVERABLE_POSTCONDITION_STATUSES.includes(post.status)) {
        const ambiguous = {
          ok: false,
          resumed: true,
          idempotency_key: key,
          commit_token: adapter.getCommitted?.(key)?.commit_token ?? null,
          postcondition_status: post.status,
        };
        await checkpointStep({
          functionId,
          stepId,
          kind,
          status: post.status,
          output: ambiguous,
          effectKey: key,
        });
        throw new AmbiguousPostconditionError(
          `postcondition ${post.status} after prior commit; remains recoverable (fail-closed)`,
          { idempotency_key: key, postcondition_status: post.status }
        );
      }
      await checkpointStep({
        functionId,
        stepId,
        kind,
        status: 'ERROR',
        error: {
          message: `postcondition ${post.status} is terminal after ambiguous recovery`,
          name: 'DbosError',
          code: 'EFFECT_POSTCONDITION_UNVERIFIED',
        },
        effectKey: key,
      });
      throw new DbosError(
        'EFFECT_POSTCONDITION_UNVERIFIED',
        `postcondition ${post.status} after ambiguous recovery; refuse success (fail-closed)`,
        { idempotency_key: key, postcondition_status: post.status }
      );
    }

    /**
     * Bind EXTERNAL/TOOL/LLM steps to deterministic idempotency key +
     * adapter postcondition path (same formula as trusted-executor).
     * Crash after external commit but before checkpoint must not re-commit.
     */
    async function runEffectBoundStep(stepId, fn, { kind, effect }) {
      if (!effect || typeof effect !== 'object') {
        throw new DbosError(
          'EFFECT_BINDING_REQUIRED',
          `${kind} steps require effect binding { capability_id, request|request_hash, adapter }`
        );
      }
      const capabilityId = effect.capability_id;
      const adapter = effect.adapter;
      if (!capabilityId || !adapter) {
        throw new DbosError(
          'EFFECT_BINDING_REQUIRED',
          `${kind} steps require effect.capability_id and effect.adapter`
        );
      }
      if (typeof adapter.hasCommitted !== 'function'
        || typeof adapter.commit !== 'function'
        || typeof adapter.verifyPostcondition !== 'function') {
        throw new DbosError(
          'EFFECT_ADAPTER_INVALID',
          'effect.adapter must expose hasCommitted/commit/verifyPostcondition (trusted-executor path)'
        );
      }
      assertApprovedDisabledEffectBoundary(adapter);

      const reqHash = effect.request_hash
        || requestHash(effect.request ?? effect.canonical_request ?? {});
      const key = idempotencyKey({
        tenant_id: tenantId,
        workflow_id: workflow.workflow_id,
        step_id: stepId,
        capability_id: capabilityId,
        request_hash: reqHash,
      });

      const { existing, functionId } = await allocateFunctionId(stepId);
      if (existing) {
        if (existing.status === 'ERROR') {
          const err = new DbosError('STEP_PREVIOUSLY_FAILED', `step ${stepId} previously failed`);
          err.causePayload = existing.error_json;
          throw err;
        }
        if (RECOVERABLE_POSTCONDITION_STATUSES.includes(existing.status)) {
          return resumeAmbiguousEffectStep({
            existing,
            stepId,
            kind,
            adapter,
            key: existing.idempotency_key || key,
            functionId: existing.function_id,
          });
        }
        return existing.output_json;
      }

      await assertWritersAllowed(backend);

      // Crash recovery: external effect already committed → do not re-execute fn/commit.
      if (adapter.hasCommitted(key)) {
        const post = await adapter.verifyPostcondition({ idempotency_key: key });
        if (RECOVERABLE_POSTCONDITION_STATUSES.includes(post.status)) {
          const ambiguous = {
            ok: false,
            resumed: true,
            idempotency_key: key,
            commit_token: adapter.getCommitted?.(key)?.commit_token ?? null,
            postcondition_status: post.status,
          };
          await checkpointStep({
            functionId,
            stepId,
            kind,
            status: post.status,
            output: ambiguous,
            effectKey: key,
          });
          throw new AmbiguousPostconditionError(
            `postcondition ${post.status} after prior commit; remains recoverable (fail-closed)`,
            { idempotency_key: key, postcondition_status: post.status }
          );
        }
        if (post.status !== 'VERIFIED') {
          throw new DbosError(
            'EFFECT_POSTCONDITION_UNVERIFIED',
            `postcondition ${post.status} after prior commit; refuse duplicate (fail-closed)`,
            { idempotency_key: key, postcondition_status: post.status }
          );
        }
        const recovered = {
          ok: true,
          resumed: true,
          idempotency_key: key,
          commit_token: adapter.getCommitted?.(key)?.commit_token ?? null,
          postcondition_status: post.status,
        };
        await checkpointStep({
          functionId,
          stepId,
          kind,
          status: 'SUCCESS',
          output: recovered,
          effectKey: key,
        });
        return recovered;
      }

      let output;
      try {
        // Optional preparatory fn (must NOT itself commit the external effect).
        const prep = typeof fn === 'function' ? await fn({ idempotency_key: key, request_hash: reqHash }) : null;
        const commitResult = await adapter.commit({
          idempotency_key: key,
          request: effect.request ?? effect.canonical_request ?? prep ?? {},
        });
        const post = await adapter.verifyPostcondition({ idempotency_key: key });
        if (RECOVERABLE_POSTCONDITION_STATUSES.includes(post.status)) {
          const ambiguous = {
            ok: false,
            resumed: false,
            duplicate: commitResult.already_present === true,
            idempotency_key: key,
            commit_token: commitResult.commit_token,
            postcondition_status: post.status,
            prep: prep ?? null,
          };
          await checkpointStep({
            functionId,
            stepId,
            kind,
            status: post.status,
            output: ambiguous,
            effectKey: key,
          });
          throw new AmbiguousPostconditionError(
            `postcondition ${post.status}; success not claimed; remains recoverable (fail-closed)`,
            { idempotency_key: key, postcondition_status: post.status }
          );
        }
        if (post.status !== 'VERIFIED') {
          throw new DbosError(
            'EFFECT_POSTCONDITION_UNVERIFIED',
            `postcondition ${post.status}; success not claimed (fail-closed)`,
            { idempotency_key: key, postcondition_status: post.status }
          );
        }
        output = {
          ok: true,
          resumed: false,
          duplicate: commitResult.already_present === true,
          idempotency_key: key,
          commit_token: commitResult.commit_token,
          postcondition_status: post.status,
          prep: prep ?? null,
        };
      } catch (e) {
        if (e instanceof AmbiguousPostconditionError) {
          throw e;
        }
        if (e instanceof DbosError) {
          await checkpointStep({
            functionId,
            stepId,
            kind,
            status: 'ERROR',
            error: { message: e.message, name: e.name, code: e.code },
            effectKey: key,
          });
          throw e;
        }
        // Crash-after-commit: if adapter committed, do not checkpoint ERROR and
        // leave workflow recoverable so resume uses hasCommitted (no duplicate).
        if (adapter.hasCommitted(key)) {
          throw new CrashAfterEffectCommitError(
            e.message || 'crash after external commit before step checkpoint',
            { idempotency_key: key, cause_name: e.name || null }
          );
        }
        await checkpointStep({
          functionId,
          stepId,
          kind,
          status: 'ERROR',
          error: { message: e.message, name: e.name },
          effectKey: key,
        });
        throw e;
      }

      await checkpointStep({
        functionId,
        stepId,
        kind,
        status: 'SUCCESS',
        output,
        effectKey: key,
      });
      return output;
    }

    async function runStep(stepId, fn, { kind = 'STEP', effect = null } = {}) {
      if (typeof stepId !== 'string' || !stepId) {
        throw new DbosError('INVALID_STEP_ID', 'step_id required');
      }

      if (requiresEffectBinding(kind)) {
        if (!effect) {
          throw new DbosError(
            'EFFECT_BINDING_REQUIRED',
            `nondeterministic ${kind} step must bind effect/idempotency key + postcondition path (fail-closed)`
          );
        }
        return runEffectBoundStep(stepId, fn, { kind, effect });
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

      await assertWritersAllowed(backend);

      // Nondeterministic work runs only when no checkpoint exists.
      let output;
      try {
        output = await fn();
      } catch (e) {
        await checkpointStep({
          functionId,
          stepId,
          kind,
          status: 'ERROR',
          error: { message: e.message, name: e.name },
        });
        throw e;
      }

      const stored = jsonClone(output);
      await checkpointStep({
        functionId,
        stepId,
        kind,
        status: 'SUCCESS',
        output: stored,
      });
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
        await assertWritersAllowed(backend);
        const waitId = randomUUID();
        await backend.query(
          `INSERT INTO dbos.approval_waits
             (wait_id, workflow_id, tenant_id, step_id, proposal_id, status)
           VALUES ($1, $2, $3, $4, $5, 'WAITING');`,
          [waitId, workflow.workflow_id, tenantId, stepId, proposalId]
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
        await assertWritersAllowed(backend);
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
    return withTrustedTenantTx(async (backend) => {
      await assertWritersAllowed(backend);
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
        await assertWritersAllowed(backend);
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
        // Keep PENDING so restart resumes the effect-bound step without re-commit.
        if (e instanceof CrashAfterEffectCommitError || e.code === 'CRASH_AFTER_EFFECT_COMMIT') {
          return {
            status: 'ERROR',
            workflow_id: workflowId,
            output: null,
            error: { message: e.message, name: e.name, code: e.code || 'CRASH_AFTER_EFFECT_COMMIT' },
            recoverable: true,
          };
        }
        // UNKNOWN/AMBIGUOUS stay recoverable — never terminal ERROR, never SUCCEEDED.
        if (
          e instanceof AmbiguousPostconditionError
          || e.code === 'EFFECT_POSTCONDITION_AMBIGUOUS'
          || e.code === 'EFFECT_POSTCONDITION_UNKNOWN'
        ) {
          const postStatus = e.postcondition_status
            || e.details?.postcondition_status
            || (e.code === 'EFFECT_POSTCONDITION_UNKNOWN' ? 'UNKNOWN' : 'AMBIGUOUS');
          return {
            status: postStatus,
            workflow_id: workflowId,
            output: null,
            error: { message: e.message, name: e.name, code: e.code, postcondition_status: postStatus },
            recoverable: true,
            postcondition_status: postStatus,
          };
        }
        if (e instanceof WritersFrozenError || e.code === 'WRITERS_FROZEN') {
          throw e;
        }
        await assertWritersAllowed(backend);
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
    return withTrustedTenantTx(async (backend) => {
      await assertWritersAllowed(backend);
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
    return withTrustedTenantTx(async (backend) => {
      const r = await backend.query(
        `SELECT function_id, step_id, step_kind, status, output_json, idempotency_key, completed_at
           FROM dbos.operation_outputs
          WHERE workflow_id = $1
          ORDER BY function_id ASC;`,
        [workflowId]
      );
      return r.rows;
    });
  }

  async function getWorkflow(workflowId) {
    return withTrustedTenantTx(async (backend) => loadWorkflow(backend, workflowId));
  }

  // --- Restore / PITR writer freeze (#52) ---

  async function beginRestore() {
    return withRecoveryTx(async (backend) => {
      // Recovery control-plane transition: refuse if writers already mid-flight
      // without an explicit freeze epoch bump from open state is allowed.
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
    return withRecoveryTx(async (backend) => {
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
    return withRecoveryTx(async (backend) => {
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
    return withRecoveryTx(async (backend) => readRecovery(backend));
  }

  return {
    trustedTenantId,
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
