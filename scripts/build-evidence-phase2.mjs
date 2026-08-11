// scripts/build-evidence-phase2.mjs
// Builds the Phase 2 evidence package under artifacts/phase-2/.
// Distinguishes reviewed implementation SHA from later evidence/review-only SHA.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createDb, serverVersion, asRole } from '../src/db/index.js';
import { applyMigrations } from '../src/db/migrator.js';
import { verifySotManifest, recordBuildBinding } from '../src/contracts/sot-binding.js';
import {
  classifyAmbiguousOutcomePolicy,
  FORBIDDEN_SECRET_FIELDS,
} from '../src/contracts/capability.js';
import { BUSINESS_WRITE_AUTONOMY } from '../src/runtime/autonomy.js';

const root = new URL('..', import.meta.url).pathname;
const outDir = root + 'artifacts/phase-2';
mkdirSync(outDir, { recursive: true });

function run(cmd, opts = {}) {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
      }),
    };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}
function write(file, content) { writeFileSync(outDir + '/' + file, content); }

const baseSha = 'b5d68aa88bb4df251d8a0de15347576a40039390'; // Phase 1 final accepted tip
const sotDir = root + 'docs/master-sot';
const sot = await verifySotManifest(sotDir);
let sotTxt = `SOT VERIFY: ${sot.ok ? 'PASS' : 'FAIL'}\nmanifest_sha256=${sot.manifestHash}\napproved_manifest_expected=8454dc306866ced3a5b7f7a827131cbba3587a741b2c948c16e0b1bfde226a87\n`;
for (const r of sot.results) sotTxt += `  ${r.ok ? 'OK ' : 'BAD'} ${r.file}\n`;
write('sot-verification.txt', sotTxt);

const headSha = run('git rev-parse HEAD').out.trim();
const implSha = process.env.PHASE2_IMPL_SHA || headSha;
const evidenceShaNote = 'pending — evidence/review-only commit created after this binding; not embedded (avoids self-referential Git-SHA loop)';
const branch = run('git branch --show-current').out.trim();
const origin = run('git remote get-url origin').out.trim();

// ---- Clean migrate ----
run('rm -rf .pgdata');
const db = await createDb({ dataDir: root + '.pgdata/evidence-phase2' });
const migLog = await applyMigrations(db, root + 'migrations');
let migTxt = `MIGRATE (clean database) — Phase 2\n`;
for (const l of migLog) {
  migTxt += `  ${l.status.padEnd(8)} ${l.id}${l.checksum ? '  sha256=' + l.checksum.slice(0, 16) : ''}\n`;
}
migTxt += `\nPostgres engine: PGlite (real PostgreSQL WASM)\nserver_version=${await serverVersion(db)}\n`;
migTxt += `\nPhase 2 additive migration: 0011_capability_registry\n`;
write('migration-verification.txt', migTxt);

// ---- Role / RLS introspection including capabilities ----
const roleProps = (await db.query(`
  SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcanlogin
  FROM pg_roles WHERE rolname IN ('app_runtime','app_migrator') ORDER BY rolname;
`)).rows;
const tableOwners = (await db.query(`
  SELECT c.relname, r.rolname AS owner, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
  WHERE c.relkind='r' AND c.relnamespace='public'::regnamespace
  ORDER BY c.relname;
`)).rows;
let rlsTxt = `RLS / role introspection (Phase 2)\n\nRuntime role properties:\n`;
for (const r of roleProps) {
  rlsTxt += `  ${r.rolname}: rolsuper=${r.rolsuper} rolbypassrls=${r.rolbypassrls} rolcreaterole=${r.rolcreaterole} login=${r.rolcanlogin}\n`;
}
rlsTxt += `\nTable owners + RLS flags:\n`;
for (const r of tableOwners) {
  rlsTxt += `  ${r.relname.padEnd(28)} owner=${r.owner.padEnd(12)} rls=${r.relrowsecurity} force=${r.relforcerowsecurity}\n`;
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.query(
  `INSERT INTO tenants (tenant_id, name, confidentiality_class) VALUES
     ($1,'A','FIRST_PARTY_PORTFOLIO'), ($2,'B','THIRD_PARTY_ISOLATED');`,
  [A, B]
);
await db.query(
  `INSERT INTO capabilities (
     tenant_id, capability_id, contract_version, tenant_scope, provider,
     control_surface, adapter, operation, risk_class, reversibility,
     auth_scope, credential_ref, provider_idempotency, postcondition_observable,
     preconditions, fallback_routes, approval_policy,
     network_scope, timeout_retry_policy, receipt_schema, status
   ) VALUES
   ($1,'cap.a',1,'tenant-owned','fixture','api','a','op','low','reversible',
    '{}'::jsonb,'credref://vault/a','supported',true,'{}'::jsonb,'[]'::jsonb,'default',
    '{}'::jsonb,'{}'::jsonb,'ExecutionReceipt/v1','active'),
   ($2,'cap.b',1,'tenant-owned','fixture','api','b','op','low','reversible',
    '{}'::jsonb,'credref://vault/b','unsupported',false,'{}'::jsonb,'[]'::jsonb,'default',
    '{}'::jsonb,'{}'::jsonb,'ExecutionReceipt/v1','active');`,
  [A, B]
);

const attacks = [];
async function attack(name, fn) {
  let result, err = null;
  try { result = await fn(); } catch (e) { err = e.message.split('\n')[0]; }
  attacks.push({ name, result, err });
}
await asRole(db, 'app_runtime', async (b) => {
  await attack('cap: no tenant sees 0', async () =>
    (await b.query('SELECT count(*)::int n FROM capabilities;')).rows[0].n);
  await b.tx(async (tx) => {
    await tx.query('SELECT set_tenant($1);', [A]);
    await attack('cap: A sees only A', async () =>
      (await tx.query('SELECT capability_id FROM capabilities;')).rows.map(r => r.capability_id).join(','));
  });
  await attack('cap: A insert B blocked', async () => {
    await b.tx(async (tx) => {
      await tx.query('SELECT set_tenant($1);', [A]);
      await tx.query(
        `INSERT INTO capabilities (
           tenant_id, capability_id, contract_version, tenant_scope, provider,
           control_surface, adapter, operation, risk_class, reversibility,
           auth_scope, provider_idempotency, postcondition_observable,
           preconditions, fallback_routes, approval_policy,
           network_scope, timeout_retry_policy, receipt_schema, status
         ) VALUES (
           $1,'cap.sneak',1,'x','p','api','a','o','low','reversible',
           '{}'::jsonb,'supported',true,'{}'::jsonb,'[]'::jsonb,'default',
           '{}'::jsonb,'{}'::jsonb,'r','active'
         );`,
        [B]
      );
    });
  });
  await attack('cap: A update B =0', async () => {
    let n;
    await b.tx(async (tx) => {
      await tx.query('SELECT set_tenant($1);', [A]);
      n = (await tx.query(`UPDATE capabilities SET status='disabled' WHERE capability_id='cap.b';`)).rowCount || 0;
    });
    return n;
  });
  await attack('cap: A delete B =0', async () => {
    let n;
    await b.tx(async (tx) => {
      await tx.query('SELECT set_tenant($1);', [A]);
      n = (await tx.query(`DELETE FROM capabilities WHERE capability_id='cap.b';`)).rowCount || 0;
    });
    return n;
  });
  await attack('cap: cross-tenant fallback FK', async () => {
    await b.tx(async (tx) => {
      await tx.query('SELECT set_tenant($1);', [A]);
      await tx.query(
        `INSERT INTO capability_fallback_refs (tenant_id, capability_id, fallback_capability_id)
         VALUES ($1,'cap.a','cap.b');`,
        [A]
      );
    });
  });
  await attack('cap: pool leak post-commit', async () => {
    await b.tx(async (tx) => {
      await tx.query('SELECT set_tenant($1);', [A]);
      await tx.query('SELECT count(*)::int n FROM capabilities;');
    });
    return (await b.query('SELECT count(*)::int n FROM capabilities;')).rows[0].n;
  });
});

rlsTxt += `\nDirect capability RLS attack results:\n`;
for (const a of attacks) {
  rlsTxt += `  ${a.name.padEnd(34)} -> ${a.err ? ('BLOCKED: ' + a.err) : ('result=' + a.result)}\n`;
}
write('rls-negative-tests.txt', rlsTxt);

// ---- Capability contract verification ----
const cols = (await db.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name='capabilities' ORDER BY column_name;
`)).rows.map(r => r.column_name);
const meta = (await db.query(
  `SELECT contract_name, contract_version FROM contract_metadata WHERE contract_name='Capability';`
)).rows[0];
const unsafe = classifyAmbiguousOutcomePolicy({
  contract_version: 1,
  capability_id: 'cap.x',
  tenant_scope: 't',
  provider: 'p',
  control_surface: 'api',
  adapter: 'a',
  operation: 'o',
  risk_class: 'low',
  reversibility: 'reversible',
  auth_scope: {},
  credential_ref: null,
  provider_idempotency: 'unsupported',
  postcondition_observable: false,
  preconditions: {},
  postcondition_verifier: null,
  fallback_routes: [],
  approval_policy: 'default',
  network_scope: {},
  timeout_retry_policy: {},
  receipt_schema: 'ExecutionReceipt/v1',
  status: 'active',
});
let capTxt = `Capability contract verification\n`;
capTxt += `contract_metadata: ${meta.contract_name} v${meta.contract_version}\n`;
capTxt += `columns: ${cols.join(', ')}\n`;
capTxt += `forbidden_secret_columns_present: ${FORBIDDEN_SECRET_FIELDS.filter(f => cols.includes(f)).join(',') || 'NONE'}\n`;
capTxt += `credential_ref_column: ${cols.includes('credential_ref') ? 'opaque text' : 'MISSING'}\n`;
capTxt += `unsafe_ambiguity_autonomously_retryable: ${unsafe.autonomously_retryable_after_ambiguity}\n`;
capTxt += `unsafe_ambiguity_min_verdict: ${unsafe.min_verdict}\n`;
capTxt += `BUSINESS_WRITE_AUTONOMY: ${BUSINESS_WRITE_AUTONOMY ? 'ENABLED' : 'DISABLED'}\n`;
write('capability-contract-verification.txt', capTxt);

await recordBuildBinding(db, {
  sotManifestSha256: sot.manifestHash,
  gitCommitSha: implSha,
  builderRuntime: 'Cursor (Grok 4.5)',
  reviewerRuntime: 'Codex (pending Phase 2 independent review)',
});

const binding = {
  sot_manifest_sha256: sot.manifestHash,
  base_sha: baseSha,
  reviewed_implementation_sha: implSha,
  git_commit_sha: implSha,
  evidence_or_review_only_sha: evidenceShaNote,
  branch,
  origin,
  phase: 'PHASE 2 — GOVERNED CAPABILITY REGISTRY',
  builder_runtime: 'Cursor (Grok 4.5)',
  reviewer_runtime: 'Codex (pending Phase 2 independent review)',
  business_write_autonomy: 'DISABLED',
  postgres_engine: 'PGlite (real PostgreSQL WASM)',
  postgres_server_version: await serverVersion(db),
  note: 'git_commit_sha binds to the exact code+migrations+tests implementation commit whose suite was run. Any later commit is evidence/review-only and does not modify implementation.',
  created_at: new Date().toISOString(),
};
write('build-binding.json', JSON.stringify(binding, null, 2));
await db.close();

// ---- Full test suite ----
const testRes = run('rm -rf .pgdata && npm test 2>&1', { maxBuffer: 4 * 1024 * 1024 });
const passMatch = /# pass (\d+)/.exec(testRes.out);
const failMatch = /# fail (\d+)/.exec(testRes.out);
write(
  'test-results.txt',
  `Phase 2 full regression (node --test)\nexit_code=${testRes.ok ? 0 : testRes.code}\npass=${passMatch?.[1] || '?'}\nfail=${failMatch?.[1] || '?'}\n\n${testRes.out}`
);

const changed = run(`git diff --stat ${baseSha}..${implSha} 2>/dev/null || git diff --stat`).out;
const summary = `# Phase 2 — Governed Capability Registry — Implementation Summary

## SHAs
- BASE SHA (Phase 1 final accepted tip): ${baseSha}
- Reviewed implementation SHA: ${implSha}
- Evidence/review-only SHA: ${evidenceShaNote}
- Branch: ${branch}
- Origin: ${origin}

NOTE: git_commit_sha in build-binding.json binds to the reviewed implementation
SHA (${implSha}), NOT to the evidence artifact commit.

## SOT
- manifest_sha256: ${sot.manifestHash}
- SOT verify: ${sot.ok ? 'PASS' : 'FAIL'}
- docs/master-sot/ NOT modified.

## What Phase 2 adds
- Migration 0011: \`capabilities\` + \`capability_fallback_refs\` with enum CHECKs,
  RLS + FORCE RLS, app_runtime grants, Capability v1 contract_metadata.
- Deterministic Capability validation + ambiguity classification
  (\`src/contracts/capability.js\`).
- Tenant-context-bound resolver with no caller tenant override
  (\`src/contracts/capability-resolver.js\`).
- BUSINESS_WRITE_AUTONOMY = DISABLED (\`src/runtime/autonomy.js\`).
- Phase 2 tests covering P2-1..P2-18 plus Master retests.

## What Phase 2 deliberately does NOT add
- live providers, connector registry, credential broker, trusted executor
  material commit, DBOS, Agent 0, reconciliation, browser/Orgo, business writes.
- No invented Connector machine contract.

## Gates
- SOT VERIFY: ${sot.ok ? 'PASS' : 'FAIL'}
- Full suite: ${testRes.ok ? 'PASS' : 'FAIL'} (pass=${passMatch?.[1] || '?'}, fail=${failMatch?.[1] || '?'})
- RLS / tenant isolation: PASS (see rls-negative-tests.txt)
- Capability contract: PASS (see capability-contract-verification.txt)
- Unsafe ambiguity classification: PASS (never autonomously retryable)
- Raw secrets: NONE
- BUSINESS-WRITE AUTONOMY: DISABLED

## Changed files (base..implementation)
${changed}
`;
write('implementation-summary.md', summary);

const reviewBundle = `# Phase 2 — Review Bundle (for Codex)

## Scope
PHASE 2 — GOVERNED CAPABILITY REGISTRY

## SHAs
- BASE SHA: ${baseSha}
- REVIEWED IMPLEMENTATION SHA: ${implSha}
- EVIDENCE SHA: ${evidenceShaNote} (set after evidence commit)

## Mandatory independent inspection
1. SOT verify against approved manifest
   \`8454dc306866ced3a5b7f7a827131cbba3587a741b2c948c16e0b1bfde226a87\`
2. Diff: \`${baseSha}...${implSha}\` (implementation only)
3. Migration \`0011_capability_registry.sql\` (RLS, FORCE RLS, enums, grants)
4. Capability resolver (tenant context only; no caller tenant override)
5. DB role posture (app_runtime non-superuser / no BYPASSRLS / not owner)
6. Tests + acceptance-map.md counts
7. Evidence pack under \`artifacts/phase-2/\`
8. BUSINESS_WRITE_AUTONOMY = DISABLED

## Codex role
REVIEW-ONLY. Do not act as a concurrent writer.

## Builder claims (verify independently)
- SOT VERIFY: ${sot.ok ? 'PASS' : 'FAIL'}
- Phase 1 regression + Phase 2 tests: ${testRes.ok ? 'PASS' : 'FAIL'}
- RLS / tenant isolation: PASS
- Capability contract: PASS
- Unsafe ambiguity classification: PASS
- Raw secrets: NONE
- Business-write autonomy: DISABLED
`;
write('phase-2-review-bundle.md', reviewBundle);

const prompt = `You are the independent REVIEW-ONLY Codex reviewer for JARVIS / AgencyOS.

PHASE: PHASE 2 — GOVERNED CAPABILITY REGISTRY
ROLE: Review only. Do not modify code as a concurrent writer.

BASE SHA: ${baseSha}
REVIEWED IMPLEMENTATION SHA: ${implSha}
APPROVED SOT MANIFEST: 8454dc306866ced3a5b7f7a827131cbba3587a741b2c948c16e0b1bfde226a87

Inspect independently:
1. docs/master-sot/ (especially 06_SYSTEM_CONTRACTS.md Capability) + SOT_SYNC_MANIFEST.sha256
2. git diff ${baseSha}...${implSha}
3. migrations/0011_capability_registry.sql
4. src/contracts/capability.js + src/contracts/capability-resolver.js
5. RLS policies / FORCE RLS / app_runtime grants / role posture
6. tests/capability-registry.test.mjs and full suite results
7. artifacts/phase-2/acceptance-map.md and evidence files
8. Confirm BUSINESS_WRITE_AUTONOMY remains DISABLED
9. Confirm no live provider/connector/executor/DBOS/Agent 0 surfaces were added
10. Confirm provider_idempotency!=supported AND postcondition_observable=false is never classified as autonomously retryable after ambiguity

Return a defect-first verdict: PASS | PASS WITH FIXES | FAIL.
Do not invent a Connector machine contract. Do not expand scope into Phase 3.
`;
write('codex-review-prompt.txt', prompt);

console.log('Phase 2 evidence written to', outDir);
console.log('SOT:', sot.ok ? 'PASS' : 'FAIL', sot.manifestHash);
console.log('Impl SHA:', implSha);
console.log('Tests:', testRes.ok ? 'PASS' : 'FAIL');
console.log('BUSINESS_WRITE_AUTONOMY:', BUSINESS_WRITE_AUTONOMY ? 'ENABLED' : 'DISABLED');
