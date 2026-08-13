// Shared harness for real multi-process PostgreSQL live verification tests.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';
export const TENANT_C = '33333333-3333-3333-3333-333333333333';

const workerPath = fileURLToPath(new URL('./postgres-boundary-worker.mjs', import.meta.url));

export function runPostgresWorker(mode, payload) {
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

export function parseWorkerJson(raw) {
  return JSON.parse(raw);
}
