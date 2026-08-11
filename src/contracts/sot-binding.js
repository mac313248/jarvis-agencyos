// src/contracts/sot-binding.js
// SOTBuildBinding + SOT mismatch guard per 06_SYSTEM_CONTRACTS.md and
// acceptance test #49/#20: "coding agent refuses to proceed if repo SOT hash
// mismatches approved manifest."

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function sha256File(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

// Verify every file listed in the manifest matches its recorded hash.
// Returns { ok, manifestHash, results: [{file, expected, actual, ok}] }.
// manifestHash = sha256 over the manifest file contents (the "approved manifest").
export async function verifySotManifest(sotDir) {
  const manifestPath = join(sotDir, 'SOT_SYNC_MANIFEST.sha256');
  const manifestText = await readFile(manifestPath, 'utf8');
  const manifestHash = createHash('sha256').update(manifestText, 'utf8').digest('hex');
  const results = [];
  let ok = true;
  for (const line of manifestText.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (!m) continue;
    const expected = m[1];
    const file = m[2].replace(/^\*/, '');
    let actual;
    try {
      actual = await sha256File(join(sotDir, file));
    } catch (e) {
      actual = null;
    }
    const fileOk = actual === expected;
    if (!fileOk) ok = false;
    results.push({ file, expected, actual, ok: fileOk });
  }
  return { ok, manifestHash, results };
}

export class SotMismatchError extends Error {
  constructor(results, manifestHash) {
    super('SOT manifest mismatch: refusing to proceed');
    this.name = 'SotMismatchError';
    this.results = results;
    this.manifestHash = manifestHash;
  }
}

// Guard: throws SotMismatchError if any SOT file hash differs from the manifest.
export async function assertSotMatches(sotDir) {
  const v = await verifySotManifest(sotDir);
  if (!v.ok) throw new SotMismatchError(v.results, v.manifestHash);
  return v;
}

// Record a SOTBuildBinding row.
export async function recordBuildBinding(backend, {
  sotManifestSha256, gitCommitSha, builderRuntime, reviewerRuntime,
}) {
  const { randomUUID } = await import('node:crypto');
  const bindingId = randomUUID();
  await backend.query(
    `INSERT INTO sot_build_bindings
       (binding_id, sot_manifest_sha256, git_commit_sha, builder_runtime, reviewer_runtime)
     VALUES ($1, $2, $3, $4, $5);`,
    [bindingId, sotManifestSha256, gitCommitSha || null, builderRuntime, reviewerRuntime || null]
  );
  return { binding_id: bindingId, sot_manifest_sha256: sotManifestSha256 };
}
