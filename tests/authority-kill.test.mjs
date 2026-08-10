// tests/authority-kill.test.mjs
// Required negative tests 32-35 (kill/revocation/fail-closed) exercised
// against the deterministic control primitive with a fake/non-business
// effect boundary. No live business-effect path is created.
//
// Tests 32-35 use the BOOTSTRAP path (readFreshAuthorityFor / revalidateBeforeCommitFor)
// because they run on the superuser/migrator connection with an explicit
// tenant (RLS does not apply to owners/superusers).
//
// The cross-tenant regression tests use the RUNTIME path (readFreshAuthority)
// under app_runtime + trusted transaction-local tenant context, proving
// app_runtime CANNOT read another tenant's authority state.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant, asRole } from './_helpers.mjs';
import {
  readFreshAuthority, readFreshAuthorityFor,
  commitAllowed, revalidateBeforeCommit, revalidateBeforeCommitFor,
  AuthorityUnavailableError,
} from '../src/contracts/authority.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/auth-test' });
  await seedTwoTenants(db, { aId: A, bId: B });
  // Seed authority_control for tenant A (revocation_epoch=0, kill_epoch=0, active)
  await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
    await tx.query(
      `INSERT INTO authority_control (tenant_id, active_authority, revocation_epoch, kill_epoch)
       VALUES ($1, true, 0, 0);`, [A]
    );
  });
  // Seed authority_control for tenant B with distinguishable epochs.
  await asRuntimeTenant(db, 'app_runtime', B, async (tx) => {
    await tx.query(
      `INSERT INTO authority_control (tenant_id, active_authority, revocation_epoch, kill_epoch)
       VALUES ($1, true, 7, 9);`, [B]
    );
  });
});
after(async () => { await db.close(); });

describe('authority / kill fail-closed (bootstrap path)', () => {

  test('32. Revocation arriving between policy decision and commit blocks commit', async () => {
    const prior = { revocationEpoch: 0, killEpoch: 0 };
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query('UPDATE authority_control SET revocation_epoch = 1 WHERE tenant_id=$1;', [A]);
    });
    const { decision, fresh } = await revalidateBeforeCommitFor(db, A, prior.revocationEpoch, prior.killEpoch);
    assert.equal(decision.allowed, false);
    assert.ok(decision.reasons.some(r => /revocation_epoch changed/.test(r)));
    assert.equal(fresh.revocationEpoch, 1);
  });

  test('33. Receipt records commit-time revocation/kill epochs', async () => {
    const fresh = await readFreshAuthorityFor(db, A);
    const receiptId = randomUUID();
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query(
        `INSERT INTO execution_receipts
           (receipt_id, tenant_id, workflow_id, step_id, actor, capability_id, provider,
            operation, target_ref, idempotency_key, request_hash,
            revocation_epoch_at_commit, kill_epoch_at_commit, started_at, committed_at,
            verification_status, trace_id)
         VALUES ($1,$2,$3,'step-1','agent0','cap.fake','fake-provider','noop','noop-target',$4,$5,
                 $6,$7, now(), now(), 'VERIFIED', $8);`,
        [receiptId, A, randomUUID(), 'idem-' + randomUUID(), 'rh', fresh.revocationEpoch, fresh.killEpoch, randomUUID()]
      );
    });
    const stored = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      (await tx.query('SELECT revocation_epoch_at_commit, kill_epoch_at_commit FROM execution_receipts WHERE receipt_id=$1;', [receiptId])).rows[0]);
    assert.equal(stored.revocation_epoch_at_commit, fresh.revocationEpoch);
    assert.equal(stored.kill_epoch_at_commit, fresh.killEpoch);
  });

  test('34. Authority/kill-store outage blocks material writes (fail-closed)', async () => {
    // No authority_control row for an unseeded tenant -> readFreshAuthorityFor throws.
    const C = '33333333-3333-3333-3333-333333333333';
    await assert.rejects(() => readFreshAuthorityFor(db, C), AuthorityUnavailableError);
  });

  test('35. Zombie worker with stale epoch cannot commit', async () => {
    const prior = { revocationEpoch: 1, killEpoch: 0 };
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query('UPDATE authority_control SET revocation_epoch = 1, kill_epoch = 1 WHERE tenant_id=$1;', [A]);
    });
    const { decision } = await revalidateBeforeCommitFor(db, A, prior.revocationEpoch, prior.killEpoch);
    assert.equal(decision.allowed, false);
    assert.ok(decision.reasons.some(r => /kill_epoch changed/.test(r)));
  });

  test('34b. Inactive authority blocks commit', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query('UPDATE authority_control SET active_authority = false, kill_epoch = 1 WHERE tenant_id=$1;', [A]);
    });
    const fresh = await readFreshAuthorityFor(db, A);
    const d = commitAllowed({ ...fresh, expectedRevocationEpoch: fresh.revocationEpoch, expectedKillEpoch: fresh.killEpoch });
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some(r => /authority not active/.test(r)));
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query('UPDATE authority_control SET active_authority = true WHERE tenant_id=$1;', [A]);
    });
  });
});

describe('cross-tenant authority reader regression (runtime path)', () => {
  // These exercise the actual SQL/runtime path under app_runtime + trusted
  // transaction-local tenant context — not a JS mock.

  before(async () => {
    // Reset Tenant A authority_control to a clean known state. (Bootstrap
    // tests 32/34b above mutate A's epochs and only partially restore.)
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query(
        'UPDATE authority_control SET active_authority=true, revocation_epoch=0, kill_epoch=0 WHERE tenant_id=$1;', [A]
      );
    });
  });

  test('R1. Under Tenant A context, runtime reader returns Tenant A state (not Tenant B)', async () => {
    const fresh = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      readFreshAuthority(tx));
    assert.equal(fresh.activeAuthority, true);
    assert.equal(fresh.revocationEpoch, 0);
    assert.equal(fresh.killEpoch, 0);
    // And it is NOT Tenant B's state (B has rev=7, kill=9).
    assert.notEqual(fresh.revocationEpoch, 7);
    assert.notEqual(fresh.killEpoch, 9);
  });

  test('R2. Under Tenant A context, the old caller-selected cross-tenant reader is impossible', async () => {
    // The runtime reader readFreshAuthority() takes NO tenant argument.
    // The old read_authority_state(uuid) was DROPPED — calling it must fail.
    // Run in its own transaction so the error does not poison other reads.
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await assert.rejects(
        () => tx.query('SELECT * FROM read_authority_state($1);', [B]),
        /function.*does not exist|does not exist/i
      );
    });
  });

  test('R3. Under Tenant A context, the zero-arg runtime reader returns A (not B)', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      const fresh = await readFreshAuthority(tx);
      assert.notEqual(fresh.revocationEpoch, 7); // B's epoch
      assert.notEqual(fresh.killEpoch, 9);       // B's kill_epoch
      assert.equal(fresh.revocationEpoch, 0);    // A's epoch
      assert.equal(fresh.killEpoch, 0);          // A's kill_epoch
    });
  });

  test('R4. Missing tenant context fails closed; authority_control invisible to app_runtime', async () => {
    await asRole(db, 'app_runtime', async (b) => {
      await assert.rejects(() => readFreshAuthority(b), AuthorityUnavailableError);
      // Direct SELECT on authority_control with no tenant context -> RLS hides all rows.
      const n = (await b.query('SELECT count(*)::int n FROM authority_control;')).rows[0].n;
      assert.equal(n, 0, 'no tenant context -> authority_control invisible to app_runtime');
    });
  });

  test('R5. Tenant B context can read Tenant B state normally', async () => {
    const fresh = await asRuntimeTenant(db, 'app_runtime', B, async (tx) =>
      readFreshAuthority(tx));
    assert.equal(fresh.activeAuthority, true);
    assert.equal(fresh.revocationEpoch, 7);
    assert.equal(fresh.killEpoch, 9);
  });

  test('R6. Existing revocation/kill behavior preserved (runtime path revalidate)', async () => {
    const prior = { revocationEpoch: 0, killEpoch: 0 };
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query('UPDATE authority_control SET kill_epoch = 2 WHERE tenant_id=$1;', [A]);
    });
    const { decision } = await asRuntimeTenant(db, 'app_runtime', A, async (tx) =>
      revalidateBeforeCommit(tx, prior.revocationEpoch, prior.killEpoch));
    assert.equal(decision.allowed, false);
    assert.ok(decision.reasons.some(r => /kill_epoch changed/.test(r)));
    // restore
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query('UPDATE authority_control SET kill_epoch = 0 WHERE tenant_id=$1;', [A]);
    });
  });
});
