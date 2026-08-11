// src/db/migrator.js
// Deterministic, ordered SQL migration runner.
//
// - Migrations are plain .sql files in /migrations, sorted by filename.
// - Applied migrations are tracked in the `schema_migrations` table.
// - Runs as the migrator/bootstrap role (DDL), NOT the runtime role.
// - Idempotent: re-running skips already-applied migrations.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function listMigrations(dir) {
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  return files.map(f => ({ id: f.replace(/\.sql$/, ''), path: join(dir, f) }));
}

export async function ensureMigrationsTable(backend) {
  await backend.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum_sha256 text NOT NULL
    );
  `);
}

async function sha256(s) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export async function applyMigrations(backend, dir) {
  await ensureMigrationsTable(backend);
  const files = await listMigrations(dir);
  const applied = new Set(
    (await backend.query('SELECT id FROM schema_migrations;')).rows.map(r => r.id)
  );
  const log = [];
  for (const f of files) {
    if (applied.has(f.id)) { log.push({ id: f.id, status: 'skipped' }); continue; }
    const sql = await readFile(f.path, 'utf8');
    const checksum = await sha256(sql);
    await backend.exec('BEGIN');
    try {
      await backend.exec(sql);
      await backend.query(
        'INSERT INTO schema_migrations (id, checksum_sha256) VALUES ($1, $2);',
        [f.id, checksum]
      );
      await backend.exec('COMMIT');
      log.push({ id: f.id, status: 'applied', checksum });
    } catch (e) {
      await backend.exec('ROLLBACK');
      log.push({ id: f.id, status: 'failed', error: e.message });
      throw new Error(`Migration ${f.id} failed: ${e.message}`);
    }
  }
  return log;
}
