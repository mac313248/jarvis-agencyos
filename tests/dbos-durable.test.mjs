// tests/dbos-durable.test.mjs
// F-09 DBOS durable workflows acceptance:
//   #50 DBOS completed step survives restart without duplicate execution
//   #51 approval wait survives restart
//   #52 restore sequence freezes writers until Postgres/DBOS/providers reconcile
//
// Stop conditions: duplicate execution after restart;
// writers reactivated before reconciliation.
// Business-write autonomy remains DISABLED.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import {
  createDbosRuntime,
  DbosError,
  WritersFrozenError,
  DBOS_ROLE,
  assertWritersAllowed,
} from '../src/runtime/dbos.js';
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
});

describe('F-09 #50 completed step survives restart without duplicate execution', () => {
  test('replay after process restart returns checkpointed outputs and does not re-run steps', async () => {
    const counters = { llm: 0, tool: 0 };
    const workflowId = randomUUID();

    // Process A: run both durable steps to completion.
    const runtimeA = createDbosRuntime(db);
    registerDemoWorkflow(runtimeA, counters);
    const first = await runtimeA.startWorkflow(
      'demo.llm_then_tool',
      { goal: 'brief' },
      { workflowId, tenantId: A }
    );
    assert.equal(first.status, 'SUCCESS');
    assert.equal(counters.llm, 1);
    assert.equal(counters.tool, 1);
    assert.equal(first.output.llm.n, 1);
    assert.equal(first.output.tool.n, 1);

    // Process B: new runtime instance (restart). Same Postgres checkpoints.
    const countersAfterRestart = { llm: 0, tool: 0 };
    const runtimeB = createDbosRuntime(db);
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

    const runtimeA = createDbosRuntime(db);
    register(runtimeA);
    const parked = await runtimeA.startWorkflow(
      'demo.partial',
      { goal: 'x' },
      { workflowId, tenantId: A }
    );
    assert.equal(parked.status, 'WAITING');
    assert.equal(counters.llm, 1);
    assert.equal(counters.tool, 0);

    // Restart before gate is signaled — completed llm step must not re-run.
    const runtimeB = createDbosRuntime(db);
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

    const runtimeA = createDbosRuntime(db);
    register(runtimeA);
    const waiting = await runtimeA.startWorkflow(
      'demo.needs_approval',
      {},
      { workflowId, tenantId: A }
    );
    assert.equal(waiting.status, 'WAITING');
    assert.equal(waiting.wait.step_id, 'owner.approve');
    assert.equal(counters.prep, 1);
    assert.equal(counters.after, 0);

    // Restart while still waiting — wait row must survive.
    const runtimeB = createDbosRuntime(db);
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
    const runtimeC = createDbosRuntime(db);
    register(runtimeC);
    const again = await runtimeC.resumeWorkflow(workflowId);
    assert.equal(again.status, 'SUCCESS');
    assert.equal(counters.prep, 1);
    assert.equal(counters.after, 1);
  });
});

describe('F-09 #52 restore freezes writers until reconcile', () => {
  test('writers stay frozen until Postgres/DBOS/providers reconcile; premature thaw refused', async () => {
    const runtime = createDbosRuntime(db);

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
