#!/usr/bin/env node
// Runs the real multi-process PostgreSQL live verification battery and prints
// a compact evidence summary to stdout. Does not set PASS/DONE.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
}

const checks = [
  { name: 'verify:sot', argv: ['npm', 'run', 'verify:sot'] },
  { name: 'test:v1.0a-postgres', argv: ['npm', 'run', 'test:v1.0a-postgres'] },
  { name: 'postgres-live-verification', argv: ['npm', 'run', 'test:postgres-live-verification'] },
  { name: 'rls-negative', argv: ['node', '--test', 'tests/rls-negative.test.mjs'] },
];

const results = [];
for (const check of checks) {
  try {
    const out = run(check.argv[0], check.argv.slice(1));
    const passMatch = out.match(/# pass (\d+)/);
    results.push({
      name: check.name,
      ok: true,
      pass: passMatch ? Number(passMatch[1]) : null,
    });
  } catch (err) {
    results.push({
      name: check.name,
      ok: false,
      output: String(err.stdout || err.stderr || err.message).slice(-2000),
    });
  }
}

const ok = results.every((r) => r.ok);
console.log(JSON.stringify({
  task: 'postgres-tenant-boundary-live-verification',
  acceptance_ref: '04_LIVE_VERIFICATION_BACKLOG.md#Postgres--tenant-boundary',
  engine: 'embedded-postgres (real OS process, multi-process pg connections)',
  ok,
  checks: results,
  note: 'Worker evidence only; Jarvis/Builder Core retains PASS/DONE authority',
}, null, 2));

process.exit(ok ? 0 : 1);
