// tests/authority-kill.test.mjs
// Required negative tests 32-35 (kill/revocation/fail-closed) exercised
// against the deterministic control primitive with a fake/non-business
// effect boundary. No live business-effect path is created.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshCluster, seedTwoTenants, asRuntimeTenant } from './_helpers.mjs';
import { readFreshAuthority, commitAllowed, revalidateBeforeCommit, AuthorityUnavailableError } from '../src/contracts/authority.js';

let db;
const A = '11111111-1111-1111-1111-111111111111';

before(async () => {
  db = await freshCluster({ dataDir: './.pgdata/auth-test' });
  await seedTwoTenants(db, { aId: A });
  // Seed authority_control for tenant A (revocation_epoch=0, kill_epoch=0, active)
  await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
    await tx.query(
      `INSERT INTO authority_control (tenant_id, active_authority, revocation_epoch, kill_epoch)
       VALUES ($1, true, 0, 0);`, [A]
    );
  });
});
after(async () => { await db.close(); });

describe('authority / kill fail-closed', () => {

  test('32. Revocation arriving between policy decision and commit blocks commit', async () => {
    // Prior epochs captured at policy-decision time.
    const prior = { revocationEpoch: 0, killEpoch: 0 };
    // Revocation bumps the epoch before commit.
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query('UPDATE authority_control SET revocation_epoch = 1 WHERE tenant_id=$1;', [A]);
    });
    // Revalidate immediately before commit -> must block.
    const { decision, fresh } = await revalidateBeforeCommit(db, A, prior.revocationEpoch, prior.killEpoch);
    assert.equal(decision.allowed, false);
    assert.ok(decision.reasons.some(r => /revocation_epoch changed/.test(r)));
    assert.equal(fresh.revocationEpoch, 1);
  });

  test('33. Receipt records commit-time revocation/kill epochs', async () => {
    const fresh = await readFreshAuthority(db, A);
    // Record a receipt carrying the commit-time epochs (fake/non-business effect).
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
    // No authority_control row for tenant B -> readFreshAuthority throws.
    const B = '22222222-2222-2222-2222-222222222222';
    await assert.rejects(() => readFreshAuthority(db, B), AuthorityUnavailableError);
  });

  test('35. Zombie worker with stale epoch cannot commit', async () => {
    // A zombie captured epochs (rev=1, kill=0) at decision time, but kill was
    // bumped to 1 before its late commit -> must block.
    const prior = { revocationEpoch: 1, killEpoch: 0 };
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query('UPDATE authority_control SET revocation_epoch = 1, kill_epoch = 1 WHERE tenant_id=$1;', [A]);
    });
    const { decision } = await revalidateBeforeCommit(db, A, prior.revocationEpoch, prior.killEpoch);
    assert.equal(decision.allowed, false);
    assert.ok(decision.reasons.some(r => /kill_epoch changed/.test(r)));
  });

  test('34b. Inactive authority blocks commit', async () => {
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query('UPDATE authority_control SET active_authority = false, kill_epoch = 1 WHERE tenant_id=$1;', [A]);
    });
    const fresh = await readFreshAuthority(db, A);
    const d = commitAllowed({ ...fresh, expectedRevocationEpoch: fresh.revocationEpoch, expectedKillEpoch: fresh.killEpoch });
    assert.equal(d.allowed, false);
    assert.ok(d.reasons.some(r => /authority not active/.test(r)));
    // restore for subsequent tests
    await asRuntimeTenant(db, 'app_runtime', A, async (tx) => {
      await tx.query('UPDATE authority_control SET active_authority = true WHERE tenant_id=$1;', [A]);
    });
  });
});
