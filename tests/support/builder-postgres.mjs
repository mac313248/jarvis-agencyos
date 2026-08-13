// Disposable PostgreSQL for Builder Core store tests.
// Does NOT apply AgencyOS business migrations.

import EmbeddedPostgres from 'embedded-postgres';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

export async function startBuilderPostgresServer() {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-builder-pg-'));
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
  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  return {
    databaseUrl,
    port,
    root,
    async stop() {
      try { await pg.stop(); } catch { /* ignore */ }
      try { await rm(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
