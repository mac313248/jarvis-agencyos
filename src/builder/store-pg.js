// Synchronous PostgreSQL BuilderStore facade.
// Preserves the existing Builder Core store API for production agents.

import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
} from 'node:worker_threads';
import { BuilderStoreError } from './store-errors.js';

const STORE_METHODS = [
  'close',
  'schemaVersion',
  'insertTask',
  'tryInsertTask',
  'getTask',
  'listTasks',
  'updateTask',
  'insertRun',
  'getRun',
  'listRunsForTask',
  'updateRun',
  'listActiveRuns',
  'insertCandidate',
  'getCandidate',
  'updateCandidate',
  'listCandidatesForTask',
  'insertVerification',
  'getVerification',
  'listVerificationsForCandidate',
  'updateVerification',
  'updateApproval',
  'insertReview',
  'getReview',
  'updateReview',
  'listReviewsForCandidate',
  'insertApproval',
  'getApproval',
  'listApprovalsForTask',
  'appendEvent',
  'listEventsForTask',
  'tryAcquireLease',
  'releaseLease',
  'reconstruct',
];

export class PostgresBuilderStore {
  constructor({ worker, port, lock }) {
    this.kind = 'postgres';
    this.backend = 'postgres';
    this.dbPath = null;
    this._worker = worker;
    this._port = port;
    this._lock = lock;
    this._closed = false;
    for (const method of STORE_METHODS) {
      if (method === 'close') continue;
      this[method] = (...args) => this._call(method, args);
    }
  }

  _call(method, args) {
    if (this._closed) {
      throw new BuilderStoreError('builder store is closed', 'STORE_CLOSED');
    }
    Atomics.store(this._lock, 0, 0);
    this._port.postMessage({ method, args });
    const wait = Atomics.wait(this._lock, 0, 0, 120000);
    if (wait === 'timed-out') {
      throw new BuilderStoreError(
        'shared Builder store unavailable',
        'SHARED_STORE_UNAVAILABLE'
      );
    }
    const msg = receiveMessageOnPort(this._port)?.message;
    if (!msg) {
      throw new BuilderStoreError(
        'shared Builder store unavailable',
        'SHARED_STORE_UNAVAILABLE'
      );
    }
    if (!msg.ok) {
      throw new BuilderStoreError(
        msg.error?.message || 'store error',
        msg.error?.code || 'STORE_ERROR'
      );
    }
    return msg.result;
  }

  close() {
    if (this._closed) return;
    try {
      this._call('close', []);
    } catch {
      // Worker may already be gone.
    }
    this._closed = true;
    try {
      this._port.close();
    } catch {
      // ignore
    }
    void this._worker.terminate();
  }
}

export function connectPostgresBuilderStore(databaseUrl) {
  return new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    const sab = new SharedArrayBuffer(4);
    const lock = new Int32Array(sab);
    let settled = false;
    const worker = new Worker(new URL('./store-pg-worker.js', import.meta.url), {
      workerData: { databaseUrl },
    });
    const fail = () => {
      if (settled) return;
      settled = true;
      try {
        port1.close();
      } catch {
        // ignore
      }
      void worker.terminate();
      reject(
        new BuilderStoreError(
          'shared Builder store unavailable',
          'SHARED_STORE_UNAVAILABLE'
        )
      );
    };
    worker.once('error', fail);
    worker.once('exit', (code) => {
      if (!settled && code !== 0) fail();
    });
    worker.once('message', (msg) => {
      if (settled) return;
      if (msg?.type === 'ready') {
        settled = true;
        worker.off('error', fail);
        resolve(new PostgresBuilderStore({ worker, port: port1, lock }));
        return;
      }
      fail();
    });
    worker.postMessage({ type: 'init', port: port2, sab }, [port2]);
  });
}
