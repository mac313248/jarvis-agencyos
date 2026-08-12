// Repo-native Cursor builder capability verification.
// Proves SDK import, skill/agent/rule layout, relative references, and
// Jarvis authority overlay. Does not treat Team Kit as PASS/DONE authority.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const skillsRoot = join(repoRoot, '.cursor/skills');
const agentsRoot = join(repoRoot, '.cursor/agents');
const rulesRoot = join(repoRoot, '.cursor/rules');
const provenancePath = join(
  repoRoot,
  '.cursor/vendor/cursor-plugins/PROVENANCE.json'
);

const EXPECTED_SKILLS = [
  'cursor-sdk',
  'cli-for-agents',
  'check-compiler-errors',
  'control-cli',
  'control-ui',
  'deslop',
  'fix-ci',
  'fix-merge-conflicts',
  'get-pr-comments',
  'loop-on-ci',
  'make-pr-easy-to-review',
  'new-branch-and-pr',
  'pr-review-canvas',
  'review-and-ship',
  'run-smoke-tests',
  'thermo-nuclear-code-quality-review',
  'verify-this',
  'weekly-review',
  'what-did-i-get-done',
  'workflow-from-chats',
];

const EXPECTED_SDK_REFS = [
  'runtime-choice.md',
  'auth.md',
  'error-handling.md',
  'streaming.md',
  'mcp.md',
  'advanced.md',
  'patterns.md',
];

const EXPECTED_AGENTS = [
  'ci-watcher.md',
  'thermo-nuclear-code-quality-review.md',
];

const CONVENIENCE_SKILLS = [
  'review-and-ship',
  'new-branch-and-pr',
  'loop-on-ci',
  'fix-ci',
  'fix-merge-conflicts',
  'make-pr-easy-to-review',
];

const RELATIVE_LINK = /\]\(([^)]+)\)/g;

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function skillFrontmatterName(skillMd) {
  const text = readFileSync(skillMd, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, `missing YAML frontmatter: ${skillMd}`);
  const name = m[1].match(/^name:\s*(.+)$/m);
  assert.ok(name, `missing name in frontmatter: ${skillMd}`);
  return name[1].trim();
}

function assertRelativeRefsExist(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const base = dirname(filePath);
  for (const match of text.matchAll(RELATIVE_LINK)) {
    const raw = match[1].split('#')[0].split(' ')[0].trim();
    if (!raw) continue;
    if (/^(https?:|mailto:|data:)/i.test(raw)) continue;
    if (raw.startsWith('/')) continue;
    const target = resolve(base, raw);
    assert.equal(
      existsSync(target),
      true,
      `broken relative reference in ${filePath}: ${raw}`
    );
  }
}

describe('Cursor builder capabilities', () => {
  it('A. @cursor/sdk is locked and imports', async () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies['@cursor/sdk'], '^1.0.27');
    const lock = JSON.parse(
      readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')
    );
    assert.equal(lock.packages['node_modules/@cursor/sdk'].version, '1.0.27');
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('@cursor/sdk');
    assert.match(resolved, /@cursor\/sdk/);
    const sdk = await import('@cursor/sdk');
    assert.equal(typeof sdk.Agent, 'function');
    assert.equal(typeof sdk.Agent.create, 'function');
    assert.equal(typeof sdk.Cursor, 'function');
    assert.equal(typeof sdk.Cursor.models.list, 'function');
  });

  it('B. expected SKILL.md files exist with matching names and refs', () => {
    for (const name of EXPECTED_SKILLS) {
      const skillMd = join(skillsRoot, name, 'SKILL.md');
      assert.equal(existsSync(skillMd), true, `missing skill: ${name}`);
      assert.equal(skillFrontmatterName(skillMd), name);
    }
    for (const ref of EXPECTED_SDK_REFS) {
      assert.equal(
        existsSync(join(skillsRoot, 'cursor-sdk/references', ref)),
        true,
        `missing SDK reference: ${ref}`
      );
    }
    for (const extra of [
      'pr-review-canvas/renderer.js',
      'pr-review-canvas/styles.css',
      'pr-review-canvas/template.html',
    ]) {
      assert.equal(
        existsSync(join(skillsRoot, extra)),
        true,
        `missing canvas asset: ${extra}`
      );
    }
    for (const file of walkFiles(skillsRoot)) {
      if (/\.(md|html|css|js)$/.test(file)) assertRelativeRefsExist(file);
    }
  });

  it('C. Team Kit agents/rules plus Jarvis authority overlay', () => {
    for (const agent of EXPECTED_AGENTS) {
      assert.equal(
        existsSync(join(agentsRoot, agent)),
        true,
        `missing subagent: ${agent}`
      );
    }
    const authority = readFileSync(
      join(rulesRoot, 'jarvis-authority.mdc'),
      'utf8'
    );
    assert.match(authority, /alwaysApply:\s*true/);
    assert.match(authority, /authority plane/i);
    assert.match(authority, /PASS \/ DONE|PASS\/DONE/);
    for (const skill of CONVENIENCE_SKILLS) {
      assert.match(
        authority,
        new RegExp(skill),
        `authority overlay must name ${skill}`
      );
    }
    assert.match(
      authority,
      /cannot independently declare|may \*\*not\*\* set Jarvis task PASS\/DONE/i
    );
    assert.equal(existsSync(join(rulesRoot, 'no-inline-imports.mdc')), true);
    const tsRule = readFileSync(
      join(rulesRoot, 'typescript-exhaustive-switch.mdc'),
      'utf8'
    );
    assert.match(tsRule, /alwaysApply:\s*false/);
    assert.match(tsRule, /\.ts/);
  });

  it('D. cli-for-agents skill present; agent CLI optional', () => {
    assert.equal(
      existsSync(join(skillsRoot, 'cli-for-agents/SKILL.md')),
      true
    );
    const probed = spawnSync('agent', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const present = probed.error?.code !== 'ENOENT' && probed.status === 0;
    if (!present) {
      console.log(
        'CURSOR_AGENT_CLI_BINARY present=NO reason=not_on_path note=CLI binary optional/not required — SDK remains primary.'
      );
    } else {
      console.log(
        `CURSOR_AGENT_CLI_BINARY present=YES version=${(probed.stdout || probed.stderr || '').trim()}`
      );
    }
    assert.equal(
      existsSync(join(repoRoot, 'package.json')),
      true,
      'SDK capability must not depend on agent CLI binary'
    );
  });

  it('E. provenance, licenses, no production credential config', () => {
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    assert.equal(provenance.source_repository, 'https://github.com/cursor/plugins');
    assert.match(provenance.upstream_commit_sha, /^[0-9a-f]{40}$/);
    assert.equal(provenance.license, 'MIT');
    for (const lic of provenance.license_files) {
      assert.equal(existsSync(join(repoRoot, lic)), true, `missing ${lic}`);
    }
    const env = JSON.parse(
      readFileSync(join(repoRoot, '.cursor/environment.json'), 'utf8')
    );
    assert.equal(env.install, 'npm ci');
    assert.equal(env.start, undefined);
    const envText = JSON.stringify(env);
    assert.equal(/CURSOR_API_KEY|sk-|ghp_|ghl_/i.test(envText), false);
    const docs = readFileSync(
      join(repoRoot, 'docs/CURSOR_BUILDER_CAPABILITIES.md'),
      'utf8'
    );
    assert.match(docs, /CLI binary optional\/not required/);
    assert.match(docs, /authority plane/);
  });
});
