// scripts/migrate.mjs
// Apply all migrations to a clean (or existing) database.
// Default engine: PGlite at .pgdata/phase1. Override with DATABASE_URL for
// a real multi-process PostgreSQL cluster.
import { createDb } from '../src/db/index.js';
import { applyMigrations } from '../src/db/migrator.js';

const dataDir = process.env.PGDATA || new URL('../.pgdata/phase1', import.meta.url).pathname;
const migDir = new URL('../migrations/', import.meta.url).pathname;

const db = await createDb({ dataDir });
try {
  const log = await applyMigrations(db, migDir);
  for (const l of log) console.log(`  ${l.status.padEnd(8)} ${l.id}`);
  console.log('MIGRATE: OK (' + log.filter(l => l.status === 'applied').length + ' applied, ' + log.filter(l => l.status === 'skipped').length + ' skipped)');
} finally {
  await db.close();
}
