// Worker thread for the shared PostgreSQL Builder store.
// Results return over MessagePort so the parent can wait without spinning
// the main event loop. Connection strings are never logged.

import { parentPort, workerData } from 'node:worker_threads';
import { PostgresBuilderStoreAsync } from './store-pg-async.js';

let store = null;
let port = null;
let lock = null;

async function handleRequest(msg) {
  try {
    const { method, args = [] } = msg;
    if (typeof store[method] !== 'function') {
      port.postMessage({
        ok: false,
        error: { message: `unknown store method: ${method}`, code: 'STORE_ERROR' },
      });
      return;
    }
    const result = await store[method](...args);
    port.postMessage({ ok: true, result });
  } catch (err) {
    port.postMessage({
      ok: false,
      error: {
        message: String(err?.message || 'store error'),
        code: err?.code || 'STORE_ERROR',
        name: err?.name || 'Error',
      },
    });
  } finally {
    Atomics.store(lock, 0, 1);
    Atomics.notify(lock, 0);
  }
}

parentPort.on('message', async (msg) => {
  if (msg?.type === 'init') {
    try {
      store = await PostgresBuilderStoreAsync.connect(workerData.databaseUrl);
      port = msg.port;
      lock = new Int32Array(msg.sab);
      port.on('message', (request) => {
        void handleRequest(request);
      });
      parentPort.postMessage({ type: 'ready' });
    } catch {
      parentPort.postMessage({ type: 'error' });
    }
    return;
  }
  if (msg?.type === 'shutdown') {
    try {
      if (store) await store.close();
    } catch {
      // ignore
    }
    parentPort.postMessage({ type: 'closed' });
  }
});
