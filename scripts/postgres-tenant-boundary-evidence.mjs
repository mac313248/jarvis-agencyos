#!/usr/bin/env node
// scripts/postgres-tenant-boundary-evidence.mjs
// Captures live-verification evidence for Postgres / tenant boundary.
// Does not certify PASS/DONE; records command output only.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'artifacts/live-verification/postgres-tenant-boundary');

function run(label, cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { label, ok: true, out };
  } catch (err) {
    return {
      label,
      ok: false,
      out: String(err.stdout || '') + String(err.stderr || err.message || err),
      code: err.status,
    };
  }
}

mkdirSync(OUT_DIR, { recursive: true });

const headSha = run('head', 'git', ['rev-parse', 'HEAD']).out.trim();
const commands = [
  run('verify:sot', 'npm', ['run', 'verify:sot']),
  run('test:v1.0a-postgres', 'npm', ['run', 'test:v1.0a-postgres']),
  run('test:postgres-tenant-boundary-live', 'npm', ['run', 'test:postgres-tenant-boundary-live']),
  run('rls-negative', 'node', ['--test', 'tests/rls-negative.test.mjs']),
];

let report = [
  'POSTGRES / TENANT BOUNDARY LIVE VERIFICATION EVIDENCE',
  `head_sha=${headSha}`,
  'acceptance_ref=04_LIVE_VERIFICATION_BACKLOG.md#Postgres--tenant-boundary',
  'certifies_pass_done=false',
  '',
].join('\n');

for (const result of commands) {
  report += `\n=== ${result.label} ===\n`;
  report += `ok=${result.ok}\n`;
  if (result.code != null) report += `exit_code=${result.code}\n`;
  report += `${result.out}\n`;
}

writeFileSync(join(OUT_DIR, 'verification.txt'), report);
console.log(report);
process.exit(commands.every((c) => c.ok) ? 0 : 1);
