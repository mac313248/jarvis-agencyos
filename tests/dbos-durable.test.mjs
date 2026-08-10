// tests/dbos-durable.test.mjs
// F-09 DBOS durable workflows acceptance:
//   #50 DBOS completed step survives restart without duplicate execution
//   #51 approval wait survives restart
//   #52 restore sequence freezes writers until Postgres/DBOS/providers reconcile
//
// Codex repair coverage:
//   RLS tenant isolation on workflows/operation_outputs/approval_waits
//   startWorkflow derives trusted tenant (no caller-selected nullable scope)
//   mutating ops gated by restore writer-freeze
//   EXTERNAL/TOOL/LLM steps bind idempotency key + postcondition path
//
// Stop conditions: duplicate execution after restart;
// writers reactivated before reconciliation.
// Business-write autonomy remains DISABLED.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant, asRole } from './_helpers.mjs';
import {
  createDbosRuntime,
  DbosError,
  WritersFrozenError,
  DBOS_ROLE,
  assertWritersAllowed,
} from '../src/runtime/dbos.js';
import { createLocalEffectAdapter } from '../src/runtime/local-effect-adapter.js';
import { idempotencyKey, requestHash } from '../src/contracts/ids.js';
import {
  BUSINESS_WRITE_AUTONOMY,
  LIVE_EXTERNAL_SIDE_EFFECTS,
  DBOS_DURABLE_WORKFLOWS,
  assertBusinessWriteAutonomyDisabled,
} from '../src/runtime/autonomy.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/dbos-durable-test' });
  await seedTwoTenants(db, { aId: A, bId: B });
});

after(async () => { await db.close(); });

function runtimeFor(tenantId) {
  return createDbosRuntime(db, { trustedTenantId: tenantId });
}

function registerDemoWorkflow(runtime, counters) {
  runtime.registerWorkflow('demo.llm_then_tool', async (ctx, input) => {
    const llm = await ctx.runStep('llm.plan', async () => {
      counters.llm += 1;
      return { plan: `plan-for-${input.goal}`, n: counters.llm };
    });
    const tool = await ctx.runStep('tool.external', async () => {
      counters.tool += 1;
      return { ok: true, from: llm.plan, n: counters.tool };
    });
    return { llm, tool };
  });
}

describe('F-09 autonomy posture', () => {
  test('business-write autonomy remains DISABLED while DBOS workflows are enabled', () => {
    assert.equal(BUSINESS_WRITE_AUTONOMY, false);
    assert.equal(LIVE_EXTERNAL_SIDE_EFFECTS, false);
    assert.equal(DBOS_DURABLE_WORKFLOWS, true);
    assert.equal(assertBusinessWriteAutonomyDisabled(), true);
  });

  test('dbos schema/role separation exists', async () => {
    const roles = await db.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
        WHERE rolname = $1;`,
      [DBOS_ROLE]
    );
    assert.equal(roles.rows.length, 1);
    assert.equal(roles.rows[0].rolsuper, false);
    assert.equal(roles.rows[0].rolbypassrls, false);

    const schema = await db.query(
      `SELECT nspname FROM pg_namespace WHERE nspname = 'dbos';`
    );
    assert.equal(schema.rows.length, 1);
  });

  test('createDbosRuntime requires trusted tenant context (fail-closed)', () => {
    assert.throws(
      () => createDbosRuntime(db),
      (err) => err instanceof DbosError && err.code === 'MISSING_TENANT_CONTEXT'
    );
    assert.throws(
      () => createDbosRuntime(db, {}),
      (err) => err instanceof DbosError && err.code === 'MISSING_TENANT_CONTEXT'
    );
  });
});

describe('F-09 #50 completed step survives restart without duplicate execution', () => {
  test('replay after process restart returns checkpointed outputs and does not re-run steps', async () => {
    const counters = { llm: 0, tool: 0 };
    const workflowId = randomUUID();

    // Process A: run both durable steps to completion.
    const runtimeA = runtimeFor(A);
    registerDemoWorkflow(runtimeA, counters);
    const first = await runtimeA.startWorkflow(
      'demo.llm_then_tool',
      { goal: 'brief' },
      { workflowId }
    );
    assert.equal(first.status, 'SUCCESS');
    assert.equal(counters.llm, 1);
    assert.equal(counters.tool, 1);
    assert.equal(first.output.llm.n, 1);
    assert.equal(first.output.tool.n, 1);

    // Process B: new runtime instance (restart). Same Postgres checkpoints.
    const countersAfterRestart = { llm: 0, tool: 0 };
    const runtimeB = runtimeFor(A);
    registerDemoWorkflow(runtimeB, countersAfterRestart);
    const resumed = await runtimeB.resumeWorkflow(workflowId);

    assert.equal(resumed.status, 'SUCCESS');
    assert.deepEqual(resumed.output, first.output);
    // Stop condition: no duplicate execution after restart.
    assert.equal(countersAfterRestart.llm, 0);
    assert.equal(countersAfterRestart.tool, 0);
    assert.equal(counters.llm, 1);
    assert.equal(counters.tool, 1);

    const steps = await runtimeB.listCompletedSteps(workflowId);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].step_id, 'llm.plan');
    assert.equal(steps[1].step_id, 'tool.external');
  });

  test('partial completion: completed step not re-executed; remaining step runs once', async () => {
    const counters = { llm: 0, tool: 0 };
    const workflowId = randomUUID();

    function register(runtime) {
      runtime.registerWorkflow('demo.partial', async (ctx, input) => {
        const llm = await ctx.runStep('llm.plan', async () => {
          counters.llm += 1;
          return { plan: input.goal, n: counters.llm };
        });
        await ctx.waitForApproval('gate');
        const tool = await ctx.runStep('tool.external', async () => {
          counters.tool += 1;
          return { ok: true, from: llm.plan, n: counters.tool };
        });
        return { llm, tool };
      });
    }

    const runtimeA = runtimeFor(A);
    register(runtimeA);
    const parked = await runtimeA.startWorkflow(
      'demo.partial',
      { goal: 'x' },
      { workflowId }
    );
    assert.equal(parked.status, 'WAITING');
    assert.equal(counters.llm, 1);
    assert.equal(counters.tool, 0);

    // Restart before gate is signaled — completed llm step must not re-run.
    const runtimeB = runtimeFor(A);
    register(runtimeB);
    const still = await runtimeB.resumeWorkflow(workflowId);
    assert.equal(still.status, 'WAITING');
    assert.equal(counters.llm, 1);

    await runtimeB.signalApproval(workflowId, 'gate', { ok: true });
    const done = await runtimeB.resumeWorkflow(workflowId);
    assert.equal(done.status, 'SUCCESS');
    assert.equal(counters.llm, 1, 'llm step must not re-execute');
    assert.equal(counters.tool, 1, 'tool step executes once after recovery');
    assert.equal(done.output.llm.n, 1);
  });
});

describe('F-09 #51 approval wait survives restart', () => {
  test('WAITING approval persists across restart; signal then resume completes once', async () => {
    const counters = { prep: 0, after: 0 };
    const workflowId = randomUUID();
    const proposalId = randomUUID();

    function register(runtime) {
      runtime.registerWorkflow('demo.needs_approval', async (ctx) => {
        const prep = await ctx.runStep('prep', async () => {
          counters.prep += 1;
          return { ready: true, n: counters.prep };
        });
        const approval = await ctx.waitForApproval('owner.approve', { proposalId });
        const after = await ctx.runStep('after', async () => {
          counters.after += 1;
          return { approved: approval.decision, n: counters.after };
        });
        return { prep, approval, after };
      });
    }

    const runtimeA = runtimeFor(A);
    register(runtimeA);
    const waiting = await runtimeA.startWorkflow(
      'demo.needs_approval',
      {},
      { workflowId }
    );
    assert.equal(waiting.status, 'WAITING');
    assert.equal(waiting.wait.step_id, 'owner.approve');
    assert.equal(counters.prep, 1);
    assert.equal(counters.after, 0);

    // Restart while still waiting — wait row must survive.
    const runtimeB = runtimeFor(A);
    register(runtimeB);
    const stillWaiting = await runtimeB.resumeWorkflow(workflowId);
    assert.equal(stillWaiting.status, 'WAITING');
    assert.equal(stillWaiting.wait.step_id, 'owner.approve');
    assert.equal(counters.prep, 1, 'prep must not duplicate while waiting');

    const wf = await runtimeB.getWorkflow(workflowId);
    assert.equal(wf.status, 'WAITING');

    await runtimeB.signalApproval(workflowId, 'owner.approve', { decision: 'ALLOW' });
    const done = await runtimeB.resumeWorkflow(workflowId);
    assert.equal(done.status, 'SUCCESS');
    assert.equal(done.output.approval.decision, 'ALLOW');
    assert.equal(counters.prep, 1);
    assert.equal(counters.after, 1);

    // Another restart after completion still does not re-run steps.
    const runtimeC = runtimeFor(A);
    register(runtimeC);
    const again = await runtimeC.resumeWorkflow(workflowId);
    assert.equal(again.status, 'SUCCESS');
    assert.equal(counters.prep, 1);
    assert.equal(counters.after, 1);
  });
});

describe('F-09 #52 restore freezes writers until reconcile', () => {
  test('writers stay frozen until Postgres/DBOS/providers reconcile; premature thaw refused', async () => {
    const runtime = runtimeFor(A);

    const frozen = await runtime.beginRestore();
    assert.equal(frozen.writers_frozen, true);
    assert.equal(frozen.postgres_reconciled, false);
    assert.equal(frozen.dbos_reconciled, false);
    assert.equal(frozen.providers_reconciled, false);
    assert.ok(frozen.recovery_epoch >= 1);

    await assert.rejects(
      () => assertWritersAllowed(db),
      (err) => err instanceof WritersFrozenError
    );

    // Stop condition: cannot reactivate writers before reconciliation.
    await assert.rejects(
      () => runtime.completeRestore(),
      (err) => err instanceof DbosError
        && err.code === 'RECONCILE_INCOMPLETE'
        && err.details.missing.includes('postgres')
        && err.details.missing.includes('dbos')
        && err.details.missing.includes('providers')
    );

    await runtime.markReconciled('postgres');
    await assert.rejects(() => runtime.completeRestore(), (err) => {
      return err instanceof DbosError
        && err.code === 'RECONCILE_INCOMPLETE'
        && err.details.missing.includes('dbos')
        && err.details.missing.includes('providers')
        && !err.details.missing.includes('postgres');
    });

    await runtime.markReconciled('dbos');
    await assert.rejects(() => runtime.completeRestore(), (err) => {
      return err instanceof DbosError
        && err.code === 'RECONCILE_INCOMPLETE'
        && err.details.missing.includes('providers');
    });

    // Writers still frozen for app_runtime material path.
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await assert.rejects(
        () => assertWritersAllowed(tx),
        (err) => err instanceof WritersFrozenError
      );
    });

    await runtime.markReconciled('providers');
    const open = await runtime.completeRestore();
    assert.equal(open.writers_frozen, false);
    assert.equal(open.postgres_reconciled, true);
    assert.equal(open.dbos_reconciled, true);
    assert.equal(open.providers_reconciled, true);

    await assertWritersAllowed(db);
  });
});

describe('F-09 repair: RLS tenant isolation', () => {
  test('FORCE RLS on dbos workflows/operation_outputs/approval_waits; cross-tenant invisible', async () => {
    for (const table of ['workflows', 'operation_outputs', 'approval_waits']) {
      const r = await db.query(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'dbos' AND c.relname = $1;`,
        [table]
      );
      assert.equal(r.rows.length, 1, table);
      assert.equal(r.rows[0].relrowsecurity, true, `${table} RLS`);
      assert.equal(r.rows[0].relforcerowsecurity, true, `${table} FORCE RLS`);
    }

    const workflowId = randomUUID();
    const runtimeA = runtimeFor(A);
    runtimeA.registerWorkflow('demo.iso', async (ctx) => {
      await ctx.runStep('only', async () => ({ tenant: 'A' }));
      return { ok: true };
    });
    const done = await runtimeA.startWorkflow('demo.iso', {}, { workflowId });
    assert.equal(done.status, 'SUCCESS');

    // Tenant B runtime cannot see Tenant A's workflow rows.
    const runtimeB = runtimeFor(B);
    const invisible = await runtimeB.getWorkflow(workflowId);
    assert.equal(invisible, null);

    await assert.rejects(
      () => runtimeB.resumeWorkflow(workflowId),
      (err) => err instanceof DbosError && err.code === 'WORKFLOW_NOT_FOUND'
    );

    // Direct dbos_runtime query under B also sees zero rows (RLS, not app filter).
    await asRole(db, DBOS_ROLE, async (backend) => {
      await backend.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [B]);
        const wf = await tx.query(
          `SELECT count(*)::int AS n FROM dbos.workflows WHERE workflow_id = $1;`,
          [workflowId]
        );
        assert.equal(wf.rows[0].n, 0);
        const steps = await tx.query(
          `SELECT count(*)::int AS n FROM dbos.operation_outputs WHERE workflow_id = $1;`,
          [workflowId]
        );
        assert.equal(steps.rows[0].n, 0);
      });
    });

    // Tenant A still sees its own rows.
    const again = await runtimeA.getWorkflow(workflowId);
    assert.equal(again.tenant_id, A);
    assert.equal(again.status, 'SUCCESS');
  });
});

describe('F-09 repair: startWorkflow trusted tenant only', () => {
  test('caller-selected tenantId option is rejected; tenant comes from trusted runtime context', async () => {
    const runtime = runtimeFor(A);
    runtime.registerWorkflow('demo.no_caller_tenant', async () => ({ ok: true }));

    await assert.rejects(
      () => runtime.startWorkflow('demo.no_caller_tenant', {}, { tenantId: B }),
      (err) => err instanceof DbosError && err.code === 'CALLER_TENANT_SCOPE_FORBIDDEN'
    );
    await assert.rejects(
      () => runtime.startWorkflow('demo.no_caller_tenant', {}, { tenantId: null }),
      (err) => err instanceof DbosError && err.code === 'CALLER_TENANT_SCOPE_FORBIDDEN'
    );

    const workflowId = randomUUID();
    const result = await runtime.startWorkflow('demo.no_caller_tenant', {}, { workflowId });
    assert.equal(result.status, 'SUCCESS');
    const wf = await runtime.getWorkflow(workflowId);
    assert.equal(wf.tenant_id, A);
  });
});

describe('F-09 repair: writer-freeze gates mutating DBOS ops', () => {
  test('start, step checkpoint, approval signal blocked while writers frozen', async () => {
    const runtime = runtimeFor(A);
    const workflowId = randomUUID();

    runtime.registerWorkflow('demo.freeze_gate', async (ctx) => {
      await ctx.runStep('before', async () => ({ n: 1 }));
      await ctx.waitForApproval('gate');
      await ctx.runStep('after', async () => ({ n: 2 }));
      return { ok: true };
    });

    const waiting = await runtime.startWorkflow('demo.freeze_gate', {}, { workflowId });
    assert.equal(waiting.status, 'WAITING');

    await runtime.beginRestore();

    await assert.rejects(
      () => runtime.startWorkflow('demo.freeze_gate', {}, { workflowId: randomUUID() }),
      (err) => err instanceof WritersFrozenError || (err instanceof DbosError && err.code === 'WRITERS_FROZEN')
    );

    await assert.rejects(
      () => runtime.signalApproval(workflowId, 'gate', { ok: true }),
      (err) => err instanceof WritersFrozenError || (err instanceof DbosError && err.code === 'WRITERS_FROZEN')
    );

    await assert.rejects(
      () => runtime.resumeWorkflow(workflowId),
      (err) => err instanceof WritersFrozenError || (err instanceof DbosError && err.code === 'WRITERS_FROZEN')
    );

    // Thaw properly so later suites are not poisoned.
    await runtime.markReconciled('postgres');
    await runtime.markReconciled('dbos');
    await runtime.markReconciled('providers');
    await runtime.completeRestore();
  });
});

describe('F-09 repair: effect-bound EXTERNAL/TOOL steps', () => {
  test('EXTERNAL/TOOL/LLM without effect binding fails closed', async () => {
    const runtime = runtimeFor(A);
    runtime.registerWorkflow('demo.unbound_external', async (ctx) => {
      await ctx.runStep('x', async () => ({ bad: true }), { kind: 'EXTERNAL' });
      return { ok: true };
    });
    const result = await runtime.startWorkflow('demo.unbound_external', {});
    assert.equal(result.status, 'ERROR');
    assert.equal(result.error.code, 'EFFECT_BINDING_REQUIRED');
  });

  test('effect-bound TOOL step uses deterministic idempotency key; crash-after-commit does not duplicate', async () => {
    const store = new Map();
    const adapter = createLocalEffectAdapter(store);
    const workflowId = randomUUID();
    const capabilityId = 'cap.local.dbos.tool';
    const canonical = { op: 'tool_write', n: 1 };
    const rh = requestHash(canonical);
    const expectedKey = idempotencyKey({
      tenant_id: A,
      workflow_id: workflowId,
      step_id: 'tool.write',
      capability_id: capabilityId,
      request_hash: rh,
    });

    let commitCalls = 0;
    const crashingAdapter = {
      surface: adapter.surface,
      hasCommitted: (k) => adapter.hasCommitted(k),
      getCommitted: (k) => adapter.getCommitted(k),
      verifyPostcondition: (args) => adapter.verifyPostcondition(args),
      async commit(args) {
        commitCalls += 1;
        const result = await adapter.commit(args);
        if (commitCalls === 1) {
          const err = new Error('injected crash after external commit before checkpoint');
          err.name = 'CrashAfterExternalCommit';
          throw err;
        }
        return result;
      },
    };

    function register(runtime) {
      runtime.registerWorkflow('demo.effect_tool', async (ctx) => {
        const out = await ctx.runStep(
          'tool.write',
          async () => ({ prepared: true }),
          {
            kind: 'TOOL',
            effect: {
              capability_id: capabilityId,
              request: canonical,
              request_hash: rh,
              adapter: crashingAdapter,
            },
          }
        );
        return { out };
      });
    }

    const runtimeA = runtimeFor(A);
    register(runtimeA);
    const crashed = await runtimeA.startWorkflow('demo.effect_tool', {}, { workflowId });
    assert.equal(crashed.status, 'ERROR');
    assert.equal(crashed.recoverable, true);
    assert.equal(crashed.error.code, 'CRASH_AFTER_EFFECT_COMMIT');
    assert.equal(commitCalls, 1);
    assert.equal(store.has(expectedKey), true, 'external effect committed once');

    // Workflow stays PENDING (recoverable); no SUCCESS/ERROR step checkpoint yet.
    const wfAfterCrash = await runtimeA.getWorkflow(workflowId);
    assert.equal(wfAfterCrash.status, 'PENDING');
    const stepsAfterCrash = await runtimeA.listCompletedSteps(workflowId);
    assert.equal(stepsAfterCrash.length, 0);

    const runtimeB = runtimeFor(A);
    register(runtimeB);
    const recovered = await runtimeB.resumeWorkflow(workflowId);
    assert.equal(recovered.status, 'SUCCESS');
    assert.equal(commitCalls, 1, 'adapter.commit must not run again after crash');
    assert.equal(recovered.output.out.idempotency_key, expectedKey);
    assert.equal(recovered.output.out.resumed, true);
    assert.equal(recovered.output.out.postcondition_status, 'VERIFIED');
    assert.equal(store.size, 1);

    const steps = await runtimeB.listCompletedSteps(workflowId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].idempotency_key, expectedKey);
    assert.equal(steps[0].step_kind, 'TOOL');
  });
});
