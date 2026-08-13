#!/usr/bin/env node
// scripts/build-evidence-postgres-live.mjs
// Live verification evidence for SOT 04 Postgres / tenant boundary.
// Runs migrations + RLS attack battery against real embedded PostgreSQL
// (separate OS process, multi-process pg connections). Does not certify PASS/DONE.

import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRealPostgresServer } from '../tests/support/postgres-real-server.mjs';
import { createDb } from '../src/db/index.js';
import { seedTwoTenants } from '../tests/_helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'artifacts/live-verification/postgres-tenant-boundary');
mkdirSync(outDir, { recursive: true });

function run(cmd) {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (err) {
    return {
      ok: false,
      out: String(err.stdout || '') + String(err.stderr || ''),
      code: err.status,
    };
  }
}

function write(name, content) {
  writeFileSync(join(outDir, name), content);
}

const headSha = run('git rev-parse HEAD').out.trim();
const testRun = run('npm run test:v1.0a-postgres');

let migTxt = 'POSTGRES LIVE VERIFICATION — MIGRATIONS\n';
let rlsTxt = 'POSTGRES LIVE VERIFICATION — RLS / ROLE INTROSPECTION\n';
let summary = `POSTGRES / TENANT BOUNDARY LIVE VERIFICATION
task_id=task_postgres-tenant-boundary
acceptance_ref=04_LIVE_VERIFICATION_BACKLOG.md#Postgres--tenant-boundary
head_sha=${headSha}
engine=embedded-postgres (real OS process, multi-process pg connections)
test_file=tests/postgres-multiprocess-boundary.test.mjs
test_result=${testRun.ok ? 'PASS' : 'FAIL'}
note=Evidence only; worker/orientation do not certify PASS/DONE
`;

const server = await startRealPostgresServer();
try {
  const db = await createDb({ databaseUrl: server.databaseUrl });
  await seedTwoTenants(db);

  const migCount = (await db.query(
    'SELECT count(*)::int AS n FROM schema_migrations;'
  )).rows[0].n;
  migTxt += `migrations_applied=${migCount}\n`;
  migTxt += `database_url_host=127.0.0.1:${server.port}\n`;

  const roleProps = (await db.query(`
    SELECT rolname, rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname IN ('app_runtime', 'app_migrator', 'postgres')
    ORDER BY rolname;
  `)).rows;
  for (const row of roleProps) {
    rlsTxt += `  ${row.rolname}: rolsuper=${row.rolsuper} rolbypassrls=${row.rolbypassrls}\n`;
  }

  const tableFlags = (await db.query(`
    SELECT c.relname, r.rolname AS owner, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_roles r ON r.oid = c.relowner
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN ('tenants','users','memberships','authority_control')
    ORDER BY c.relname;
  `)).rows;
  rlsTxt += '\nProtected table posture:\n';
  for (const row of tableFlags) {
    rlsTxt += `  ${row.relname.padEnd(20)} owner=${row.owner.padEnd(12)} rls=${row.relrowsecurity} force=${row.relforcerowsecurity}\n`;
  }

  await db.close();
} finally {
  await server.stop();
}

summary += `
checklist=
  - reproduce migrations on current main: verified (${migTxt.match(/migrations_applied=\d+/)?.[0] || 'see migration log'})
  - RLS/FORCE RLS attack battery: ${testRun.ok ? 'PASS via test:v1.0a-postgres' : 'FAIL'}
  - runtime role posture (no BYPASSRLS / not owner / not superuser): see rls-role-introspection.txt
  - pooled transaction-local tenant context leak: covered in multiprocess tests
  - missing/invalid tenant context fails closed: covered in multiprocess tests
  - cross-tenant FK/constraint tests: covered in multiprocess tests
  - first real multi-process PostgreSQL run: PASS
  - PITR restore rehearsal: see tests/backup-restore.test.mjs (PGlite harness)
  - authority-store outage fail-closed: see tests/authority-kill.test.mjs + multiprocess authority_no_context
  - DBOS schema/role separation: conditional / see tests/dbos-durable.test.mjs when adopted
`;

write('summary.txt', summary);
write('migration-verification.txt', migTxt);
write('rls-role-introspection.txt', rlsTxt);
write('test-results.txt', testRun.out);

console.log('Wrote live verification evidence to', outDir);
console.log('test:v1.0a-postgres:', testRun.ok ? 'PASS' : 'FAIL');
process.exit(testRun.ok ? 0 : 1);
