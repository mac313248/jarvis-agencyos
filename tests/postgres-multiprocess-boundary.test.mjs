// tests/postgres-multiprocess-boundary.test.mjs
// V1.0A real multi-process PostgreSQL boundary proof.
// Separate Node child processes hold separate pg connections to one server.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRealPostgresServer } from './support/postgres-real-server.mjs';
import { createDb } from '../src/db/index.js';
import { seedTwoTenants } from './_helpers.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const workerPath = fileURLToPath(new URL('./support/postgres-boundary-worker.mjs', import.meta.url));

let server;
let databaseUrl;

function runWorker(mode, payload) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [mode, JSON.stringify(payload)], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`worker ${mode} failed (${code}): ${err || out}`));
    });
  });
}

before(async () => {
  server = await startRealPostgresServer();
  databaseUrl = server.databaseUrl;
  const db = await createDb({ databaseUrl });
  await seedTwoTenants(db);
  await db.close();
});

after(async () => {
  if (server) await server.stop();
});

describe('V1.0A real multi-process PostgreSQL boundary', () => {
  test('tenant A and tenant B see isolated rows from separate processes', async () => {
    const [aCount, bCount] = await Promise.all([
      runWorker('tenant_user_count', { databaseUrl, tenantId: A }),
      runWorker('tenant_user_count', { databaseUrl, tenantId: B }),
    ]);
    assert.equal(aCount, '1');
    assert.equal(bCount, '1');
  });

  test('cross-tenant reads remain blocked across processes', async () => {
    const tenants = await runWorker('cross_tenant_read_blocked', {
      databaseUrl,
      tenantId: A,
    });
    assert.deepEqual(JSON.parse(tenants), [A]);
  });

  test('missing tenant context fails closed in a separate process', async () => {
    const count = await runWorker('missing_context_fails_closed', { databaseUrl });
    assert.equal(count, '0');
  });

  test('concurrent processes cannot widen tenant visibility', async () => {
    const results = await Promise.all([
      runWorker('cross_tenant_read_blocked', { databaseUrl, tenantId: A }),
      runWorker('cross_tenant_read_blocked', { databaseUrl, tenantId: B }),
    ]);
    assert.deepEqual(JSON.parse(results[0]), [A]);
    assert.deepEqual(JSON.parse(results[1]), [B]);
  });
});
