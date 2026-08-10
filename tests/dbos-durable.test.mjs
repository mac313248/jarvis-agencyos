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
  allocateNextFunctionIdOrThrow,
  RECOVERY_FREEZE_ADVISORY_LOCK_KEY,
} from '../src/runtime/dbos.js';
import { createLocalEffectAdapter, LOCAL_FAKE_SURFACE } from '../src/runtime/local-effect-adapter.js';
import { idempotencyKey, requestHash } from '../src/contracts/ids.js';
import {
  BUSINESS_WRITE_AUTONOMY,
  LIVE_EXTERNAL_SIDE_EFFECTS,
  DBOS_DURABLE_WORKFLOWS,
  assertBusinessWriteAutonomyDisabled,
} from '../src/runtime/autonomy.js';
import { applyMigrations } from '../src/db/migrator.js';
import { createDb } from '../src/db/index.js';
import { mkdirSync, writeFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  test('non-local_fake adapter is refused even when LIVE_EXTERNAL_SIDE_EFFECTS constant is false', async () => {
    const runtime = runtimeFor(A);
    const liveAdapter = {
      surface: 'live_http',
      hasCommitted: () => false,
      commit: async () => ({ commit_token: 'x' }),
      verifyPostcondition: async () => ({ status: 'VERIFIED' }),
    };
    runtime.registerWorkflow('demo.live_forbidden', async (ctx) => {
      await ctx.runStep('x', async () => ({}), {
        kind: 'EXTERNAL',
        effect: {
          capability_id: 'cap.live',
          request: { a: 1 },
          adapter: liveAdapter,
        },
      });
      return { ok: true };
    });
    const result = await runtime.startWorkflow('demo.live_forbidden', {});
    assert.equal(result.status, 'ERROR');
    assert.equal(result.error.code, 'LIVE_EXTERNAL_FORBIDDEN');
  });

  test('adapter missing local_fake surface is refused (constant alone is insufficient)', async () => {
    const runtime = runtimeFor(A);
    const bare = {
      hasCommitted: () => false,
      commit: async () => ({ commit_token: 'x' }),
      verifyPostcondition: async () => ({ status: 'VERIFIED' }),
    };
    runtime.registerWorkflow('demo.bare_adapter', async (ctx) => {
      await ctx.runStep('x', async () => ({}), {
        kind: 'TOOL',
        effect: { capability_id: 'cap.bare', request: {}, adapter: bare },
      });
      return { ok: true };
    });
    const result = await runtime.startWorkflow('demo.bare_adapter', {});
    assert.equal(result.status, 'ERROR');
    assert.equal(result.error.code, 'LIVE_EXTERNAL_FORBIDDEN');
    assert.equal(LIVE_EXTERNAL_SIDE_EFFECTS, false);
    assert.equal(LOCAL_FAKE_SURFACE, 'local_fake');
  });

  test('UNKNOWN postcondition checkpoints as UNKNOWN and stays recoverable (not terminal ERROR)', async () => {
    const store = new Map();
    const adapter = createLocalEffectAdapter(store, { defaultPostcondition: 'UNKNOWN' });
    const workflowId = randomUUID();
    const capabilityId = 'cap.local.dbos.unknown';
    const canonical = { op: 'unknown_write' };
    let commitCalls = 0;
    const counting = {
      surface: adapter.surface,
      hasCommitted: (k) => adapter.hasCommitted(k),
      getCommitted: (k) => adapter.getCommitted(k),
      verifyPostcondition: (args) => adapter.verifyPostcondition(args),
      async commit(args) {
        commitCalls += 1;
        return adapter.commit(args);
      },
    };

    function register(runtime, postOverride = null) {
      runtime.registerWorkflow('demo.unknown_post', async (ctx) => {
        const effectAdapter = postOverride
          ? {
            ...counting,
            verifyPostcondition: async (args) => ({ status: postOverride, present: postOverride === 'VERIFIED' }),
          }
          : counting;
        const out = await ctx.runStep('ext.write', null, {
          kind: 'EXTERNAL',
          effect: {
            capability_id: capabilityId,
            request: canonical,
            adapter: effectAdapter,
          },
        });
        return { out };
      });
    }

    const runtimeA = runtimeFor(A);
    register(runtimeA);
    const ambiguous = await runtimeA.startWorkflow('demo.unknown_post', {}, { workflowId });
    assert.equal(ambiguous.status, 'UNKNOWN');
    assert.equal(ambiguous.recoverable, true);
    assert.equal(ambiguous.postcondition_status, 'UNKNOWN');
    assert.equal(commitCalls, 1);

    const wf = await runtimeA.getWorkflow(workflowId);
    assert.equal(wf.status, 'PENDING', 'workflow must remain recoverable, not terminal ERROR');
    const steps = await runtimeA.listCompletedSteps(workflowId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].status, 'UNKNOWN');
    assert.notEqual(steps[0].status, 'ERROR');
    assert.notEqual(steps[0].status, 'SUCCESS');

    // Resume while still UNKNOWN: no duplicate commit, still recoverable.
    const runtimeB = runtimeFor(A);
    register(runtimeB);
    const still = await runtimeB.resumeWorkflow(workflowId);
    assert.equal(still.status, 'UNKNOWN');
    assert.equal(still.recoverable, true);
    assert.equal(commitCalls, 1, 'must not re-commit while UNKNOWN');

    // Reconcile to VERIFIED without re-commit.
    const runtimeC = runtimeFor(A);
    register(runtimeC, 'VERIFIED');
    const done = await runtimeC.resumeWorkflow(workflowId);
    assert.equal(done.status, 'SUCCESS');
    assert.equal(commitCalls, 1);
    assert.equal(done.output.out.postcondition_status, 'VERIFIED');
    assert.equal(done.output.out.reconciled, true);
  });

  test('AMBIGUOUS postcondition never claims success and is not terminal ERROR', async () => {
    const store = new Map();
    const adapter = createLocalEffectAdapter(store, { defaultPostcondition: 'AMBIGUOUS' });
    const workflowId = randomUUID();
    function register(runtime) {
      runtime.registerWorkflow('demo.ambiguous_post', async (ctx) => {
        await ctx.runStep('tool.write', null, {
          kind: 'TOOL',
          effect: {
            capability_id: 'cap.local.dbos.ambiguous',
            request: { op: 1 },
            adapter,
          },
        });
        return { ok: true };
      });
    }
    const runtime = runtimeFor(A);
    register(runtime);
    const result = await runtime.startWorkflow('demo.ambiguous_post', {}, { workflowId });
    assert.equal(result.status, 'AMBIGUOUS');
    assert.equal(result.recoverable, true);
    assert.equal(result.postcondition_status, 'AMBIGUOUS');
    const wf = await runtime.getWorkflow(workflowId);
    assert.equal(wf.status, 'PENDING');
    const steps = await runtime.listCompletedSteps(workflowId);
    assert.equal(steps[0].status, 'AMBIGUOUS');
  });
});

describe('F-09 repair: allocateFunctionId writer-freeze before mutation', () => {
  test('mid-flight freeze blocks next_function_id allocation; workflow stays non-terminal', async () => {
    const runtime = runtimeFor(A);
    const workflowId = randomUUID();
    runtime.registerWorkflow('demo.alloc_freeze', async (ctx) => {
      await ctx.runStep('one', async () => ({ n: 1 }));
      await runtime.beginRestore();
      await ctx.runStep('two', async () => ({ n: 2 }));
      return { ok: true };
    });

    await assert.rejects(
      () => runtime.startWorkflow('demo.alloc_freeze', {}, { workflowId }),
      (err) => err instanceof WritersFrozenError || (err instanceof DbosError && err.code === 'WRITERS_FROZEN')
    );

    const wf = await runtime.getWorkflow(workflowId);
    assert.equal(wf.status, 'PENDING');
    assert.equal(wf.next_function_id, 1, 'second step must not allocate under freeze');
    const steps = await runtime.listCompletedSteps(workflowId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].step_id, 'one');

    await runtime.markReconciled('postgres');
    await runtime.markReconciled('dbos');
    await runtime.markReconciled('providers');
    await runtime.completeRestore();
  });
});

describe('F-09 repair: next_function_id allocation atomic with recovery freeze', () => {
  test('Scenario A: allocation completes before freeze; next_function_id does not change after writers_frozen commits', async () => {
    const runtime = runtimeFor(A);
    const workflowId = randomUUID();
    runtime.registerWorkflow('demo.alloc_atomic_a', async (ctx) => {
      await ctx.runStep('one', async () => ({ n: 1 }));
      return { ok: true };
    });

    const done = await runtime.startWorkflow('demo.alloc_atomic_a', {}, { workflowId });
    assert.equal(done.status, 'SUCCESS');
    const afterAlloc = await runtime.getWorkflow(workflowId);
    assert.equal(afterAlloc.next_function_id, 1);

    const frozen = await runtime.beginRestore();
    assert.equal(frozen.writers_frozen, true);
    assert.equal(
      (await runtime.getWorkflow(workflowId)).next_function_id,
      1,
      'freeze must not be followed by a next_function_id change'
    );

    // Direct allocate path (no prior assertWritersAllowed) must fail closed.
    await asRole(db, DBOS_ROLE, async (backend) => {
      await backend.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [A]);
        await assert.rejects(
          () => allocateNextFunctionIdOrThrow(tx, workflowId, 2),
          (err) => err instanceof WritersFrozenError || (err instanceof DbosError && err.code === 'WRITERS_FROZEN')
        );
      });
    });
    assert.equal((await runtime.getWorkflow(workflowId)).next_function_id, 1);

    await runtime.markReconciled('postgres');
    await runtime.markReconciled('dbos');
    await runtime.markReconciled('providers');
    await runtime.completeRestore();
  });

  test('Scenario B: freeze wins first; allocation fails closed without changing next_function_id', async () => {
    const runtime = runtimeFor(A);
    const workflowId = randomUUID();
    runtime.registerWorkflow('demo.alloc_atomic_b', async () => ({ seeded: true }));
    const seeded = await runtime.startWorkflow('demo.alloc_atomic_b', {}, { workflowId });
    assert.equal(seeded.status, 'SUCCESS');
    assert.equal((await runtime.getWorkflow(workflowId)).next_function_id, 0);

    // App-level gate would still pass here — then freeze commits first.
    await assertWritersAllowed(db);
    const frozen = await runtime.beginRestore();
    assert.equal(frozen.writers_frozen, true);

    const before = (await runtime.getWorkflow(workflowId)).next_function_id;
    assert.equal(before, 0);

    // Mutation-time DB gate (shared lock + conditional UPDATE), not a prior assertWritersAllowed.
    await asRole(db, DBOS_ROLE, async (backend) => {
      await backend.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [A]);
        await assert.rejects(
          () => allocateNextFunctionIdOrThrow(tx, workflowId, 1),
          (err) => err instanceof WritersFrozenError || (err instanceof DbosError && err.code === 'WRITERS_FROZEN')
        );
      });
    });

    const after = await runtime.getWorkflow(workflowId);
    assert.equal(after.next_function_id, before, 'writers_frozen=true must never be followed by next_function_id change');

    // Conditional UPDATE itself matches zero rows while frozen (DB enforcement).
    await asRole(db, DBOS_ROLE, async (backend) => {
      await backend.tx(async (tx) => {
        await tx.query('SELECT set_tenant($1);', [A]);
        await tx.query('SELECT pg_advisory_lock($1);', [RECOVERY_FREEZE_ADVISORY_LOCK_KEY]);
        try {
          const r = await tx.query(
            `UPDATE dbos.workflows w
                SET next_function_id = 99, updated_at = now()
               FROM recovery_control rc
              WHERE w.workflow_id = $1
                AND rc.control_id = 1
                AND rc.writers_frozen = false
            RETURNING w.next_function_id;`,
            [workflowId]
          );
          assert.equal(r.rows.length, 0);
        } finally {
          await tx.query('SELECT pg_advisory_unlock($1);', [RECOVERY_FREEZE_ADVISORY_LOCK_KEY]);
        }
      });
    });
    assert.equal((await runtime.getWorkflow(workflowId)).next_function_id, 0);

    await runtime.markReconciled('postgres');
    await runtime.markReconciled('dbos');
    await runtime.markReconciled('providers');
    await runtime.completeRestore();
  });
});

describe('F-09 repair: forward migration 0014 for existing 0013 DBs', () => {
  test('0014 brings pre-RLS 0013 databases to tenant columns/RLS/policies without reset', async () => {
    const migRoot = join(tmpdir(), 'f09-fwd-' + randomUUID());
    const dataDir = join(tmpdir(), 'f09-fwd-pg-' + randomUUID());
    mkdirSync(migRoot, { recursive: true });
    const realMig = new URL('../migrations/', import.meta.url).pathname;
    for (const f of readdirSync(realMig).sort()) {
      if (!f.endsWith('.sql')) continue;
      if (f.startsWith('0013') || f.startsWith('0014')) continue;
      copyFileSync(join(realMig, f), join(migRoot, f));
    }
    // Pre-repair 0013 (nullable tenant, no RLS) — what existing F-09 DBs recorded.
    writeFileSync(join(migRoot, '0013_dbos_durable_workflows.sql'), `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbos_runtime') THEN
    CREATE ROLE dbos_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS dbos AUTHORIZATION app_migrator;
REVOKE ALL ON SCHEMA dbos FROM PUBLIC;
GRANT USAGE ON SCHEMA dbos TO dbos_runtime;
GRANT USAGE ON SCHEMA dbos TO app_runtime;
CREATE TABLE dbos.workflows (
  workflow_id uuid PRIMARY KEY,
  workflow_name text NOT NULL,
  tenant_id uuid,
  status text NOT NULL CHECK (status IN ('PENDING','WAITING','SUCCESS','ERROR','CANCELLED')),
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_json jsonb,
  error_json jsonb,
  next_function_id int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dbos.workflows OWNER TO app_migrator;
CREATE TABLE dbos.operation_outputs (
  workflow_id uuid NOT NULL REFERENCES dbos.workflows(workflow_id),
  function_id int NOT NULL,
  step_id text NOT NULL,
  step_kind text NOT NULL CHECK (step_kind IN ('STEP','APPROVAL_WAIT')),
  status text NOT NULL CHECK (status IN ('SUCCESS','ERROR')),
  output_json jsonb,
  error_json jsonb,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, function_id),
  UNIQUE (workflow_id, step_id)
);
ALTER TABLE dbos.operation_outputs OWNER TO app_migrator;
CREATE TABLE dbos.approval_waits (
  wait_id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES dbos.workflows(workflow_id),
  step_id text NOT NULL,
  proposal_id uuid,
  status text NOT NULL CHECK (status IN ('WAITING','SIGNALED','CANCELLED')),
  signal_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  signaled_at timestamptz,
  UNIQUE (workflow_id, step_id)
);
ALTER TABLE dbos.approval_waits OWNER TO app_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbos.workflows TO dbos_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbos.operation_outputs TO dbos_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbos.approval_waits TO dbos_runtime;
GRANT SELECT ON dbos.workflows TO app_runtime;
GRANT SELECT ON dbos.operation_outputs TO app_runtime;
GRANT SELECT ON dbos.approval_waits TO app_runtime;
CREATE TABLE recovery_control (
  control_id int PRIMARY KEY DEFAULT 1 CHECK (control_id = 1),
  writers_frozen boolean NOT NULL DEFAULT false,
  recovery_epoch int NOT NULL DEFAULT 0,
  postgres_reconciled boolean NOT NULL DEFAULT false,
  dbos_reconciled boolean NOT NULL DEFAULT false,
  providers_reconciled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE recovery_control OWNER TO app_migrator;
INSERT INTO recovery_control (control_id, writers_frozen, recovery_epoch)
VALUES (1, false, 0) ON CONFLICT (control_id) DO NOTHING;
GRANT SELECT ON recovery_control TO app_runtime;
GRANT SELECT, UPDATE ON recovery_control TO dbos_runtime;
GRANT SELECT, UPDATE ON recovery_control TO app_migrator;
`);
    copyFileSync(
      join(realMig, '0014_dbos_tenant_rls_forward.sql'),
      join(migRoot, '0014_dbos_tenant_rls_forward.sql')
    );

    let cluster;
    try {
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
      cluster = await createDb({ dataDir });
      const log = await applyMigrations(cluster, migRoot);
      const applied = log.filter((l) => l.status === 'applied').map((l) => l.id);
      assert.ok(applied.includes('0013_dbos_durable_workflows'));
      assert.ok(applied.includes('0014_dbos_tenant_rls_forward'));

      // Seed a tenant and a pre-existing workflow row, then re-check isolation surfaces.
      await cluster.query(
        `INSERT INTO tenants (tenant_id, name, confidentiality_class)
         VALUES ($1,'Fwd','FIRST_PARTY_PORTFOLIO');`,
        [A]
      );
      await cluster.query(
        `INSERT INTO dbos.workflows (workflow_id, workflow_name, tenant_id, status)
         VALUES ($1,'demo.fwd',$2,'PENDING');`,
        [randomUUID(), A]
      );

      for (const table of ['workflows', 'operation_outputs', 'approval_waits']) {
        const r = await cluster.query(
          `SELECT c.relrowsecurity, c.relforcerowsecurity
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'dbos' AND c.relname = $1;`,
          [table]
        );
        assert.equal(r.rows[0].relrowsecurity, true, `${table} RLS via 0014`);
        assert.equal(r.rows[0].relforcerowsecurity, true, `${table} FORCE RLS via 0014`);
      }
      const cols = await cluster.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='dbos' AND table_name='operation_outputs'
            AND column_name IN ('tenant_id','idempotency_key')
          ORDER BY column_name;`
      );
      assert.deepEqual(cols.rows.map((r) => r.column_name), ['idempotency_key', 'tenant_id']);

      // Re-running 0014 is skipped by recorded id (no destructive reset required).
      const again = await applyMigrations(cluster, migRoot);
      assert.equal(again.find((l) => l.id === '0014_dbos_tenant_rls_forward').status, 'skipped');
    } finally {
      if (cluster) await cluster.close();
      try { rmSync(migRoot, { recursive: true, force: true }); } catch {}
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  });
});
