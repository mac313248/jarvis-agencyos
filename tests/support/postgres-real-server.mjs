// tests/support/postgres-real-server.mjs
// Spins up a disposable real PostgreSQL server (separate OS process) for
// multi-process boundary tests. PGlite is in-process WASM; this satisfies the
// V1.0A runbook requirement for real multi-process PostgreSQL evidence.

import EmbeddedPostgres from 'embedded-postgres';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../../src/db/index.js';
import { applyMigrations } from '../../src/db/migrator.js';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 5432;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function startRealPostgresServer() {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-pg-real-'));
  const port = await getFreePort();
  const pg = new EmbeddedPostgres({
    databaseDir: join(root, 'data'),
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  const databaseUrl =
    `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const db = await createDb({ databaseUrl });
  await applyMigrations(db, new URL('../../migrations/', import.meta.url).pathname);
  await db.close();
  return {
    databaseUrl,
    port,
    root,
    async stop() {
      try { await pg.stop(); } catch {}
      try { await rm(root, { recursive: true, force: true }); } catch {}
    },
  };
}
