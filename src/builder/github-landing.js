// GitHub landing-truth adapter for Builder Stage 1.
// Uses authenticated `gh` CLI. Never prints tokens.
// Worker prose is never accepted as merge/CI evidence.

import { execFileSync } from 'node:child_process';

export class GitHubLandingError extends Error {
  constructor(message, code = 'GITHUB_LANDING_ERROR') {
    super(message);
    this.name = 'GitHubLandingError';
    this.code = code;
  }
}

function runGh(args, { execFileSyncFn = execFileSync, cwd } = {}) {
  try {
    return execFileSyncFn('gh', args, {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    }).trim();
  } catch (err) {
    const msg = String(err?.stderr || err?.stdout || err?.message || err)
      .split('\n')[0]
      .slice(0, 300);
    throw new GitHubLandingError(`gh failed: ${msg}`, 'GH_CLI_FAILED');
  }
}

export function parseRepoSlug(remoteUrl) {
  const m = String(remoteUrl || '').match(
    /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/
  );
  if (!m) throw new GitHubLandingError(`unsupported github remote: ${remoteUrl}`);
  return { owner: m[1], repo: m[2] };
}

export function createGhLandingClient({
  owner = 'mac313248',
  repo = 'jarvis-agencyos',
  execFileSyncFn = execFileSync,
  cwd = process.cwd(),
} = {}) {
  const api = (path, ...extra) => {
    const out = runGh(['api', path, ...extra], { execFileSyncFn, cwd });
    return out ? JSON.parse(out) : null;
  };

  return {
    owner,
    repo,

    async getCommit(sha) {
      const data = api(`/repos/${owner}/${repo}/commits/${sha}`);
      return {
        sha: data.sha,
        html_url: data.html_url,
        message: data.commit?.message || '',
      };
    },

    async getPullRequest(number) {
      const data = api(`/repos/${owner}/${repo}/pulls/${number}`);
      return {
        number: data.number,
        html_url: data.html_url,
        head_ref: data.head?.ref,
        head_sha: data.head?.sha,
        base_ref: data.base?.ref,
        state: data.state,
        draft: Boolean(data.draft),
        mergeable: data.mergeable,
      };
    },

    async findPullRequestsForHead(branch) {
      const q = `repo:${owner}/${repo} is:pr head:${owner}:${branch}`;
      const data = api(
        `/search/issues?q=${encodeURIComponent(q)}&per_page=5`
      );
      const items = data?.items || [];
      return items.map((it) => ({
        number: it.number,
        html_url: it.html_url,
        state: it.state,
        title: it.title,
      }));
    },

    async getCheckRunsForCommit(sha) {
      const data = api(
        `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`
      );
      const runs = data?.check_runs || [];
      return runs.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status, // queued|in_progress|completed
        conclusion: r.conclusion, // success|failure|neutral|cancelled|skipped|timed_out|action_required|null
        html_url: r.html_url,
        started_at: r.started_at,
        completed_at: r.completed_at,
      }));
    },

    async getCombinedStatusForCommit(sha) {
      // Legacy commit statuses + useful aggregate.
      try {
        const data = api(`/repos/${owner}/${repo}/commits/${sha}/status`);
        return {
          state: data.state, // failure|pending|success
          statuses: (data.statuses || []).map((s) => ({
            context: s.context,
            state: s.state,
            target_url: s.target_url,
          })),
          total_count: data.total_count,
        };
      } catch {
        return { state: 'pending', statuses: [], total_count: 0 };
      }
    },

    summarizeCi({ checkRuns = [], combinedStatus = null } = {}) {
      const checks = checkRuns.map((r) => ({
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
      }));
      let ci_status = 'unknown';
      let ci_conclusion = null;
      if (checkRuns.length) {
        if (checkRuns.some((r) => r.status !== 'completed')) {
          ci_status = 'pending';
        } else if (
          checkRuns.some((r) =>
            ['failure', 'timed_out', 'action_required', 'cancelled'].includes(
              r.conclusion
            )
          )
        ) {
          ci_status = 'completed';
          ci_conclusion = 'failure';
        } else if (checkRuns.every((r) =>
          ['success', 'neutral', 'skipped'].includes(r.conclusion)
        )) {
          ci_status = 'completed';
          ci_conclusion = 'success';
        } else {
          ci_status = 'completed';
          ci_conclusion = 'neutral';
        }
      } else if (combinedStatus?.state) {
        ci_status =
          combinedStatus.state === 'pending'
            ? 'pending'
            : combinedStatus.state === 'success'
              ? 'completed'
              : combinedStatus.state === 'failure'
                ? 'completed'
                : 'unknown';
        ci_conclusion =
          combinedStatus.state === 'success'
            ? 'success'
            : combinedStatus.state === 'failure'
              ? 'failure'
              : null;
      }
      return {
        ci_status,
        ci_conclusion,
        checks,
        combined_state: combinedStatus?.state || null,
        captured_at: new Date().toISOString(),
      };
    },

    async getBranchHeadSha(branch) {
      const data = api(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
      );
      const sha = data?.object?.sha;
      if (!sha) {
        throw new GitHubLandingError(
          `branch head sha unavailable: ${branch}`,
          'BRANCH_SHA_MISSING'
        );
      }
      return sha;
    },

    createDraftPullRequest({ title, body, head, base = 'main' }) {
      const out = runGh(
        [
          'pr',
          'create',
          '--repo',
          `${owner}/${repo}`,
          '--draft',
          '--base',
          base,
          '--head',
          head,
          '--title',
          title,
          '--body',
          body,
        ],
        { execFileSyncFn, cwd }
      );
      // gh prints the PR URL
      const html_url = out.split('\n').filter(Boolean).at(-1);
      const number = Number((html_url.match(/\/pull\/(\d+)/) || [])[1]);
      if (!number) {
        throw new GitHubLandingError(`could not parse PR number from: ${out}`);
      }
      return { number, html_url };
    },

    closePullRequest(number) {
      runGh(
        ['pr', 'close', String(number), '--repo', `${owner}/${repo}`],
        { execFileSyncFn, cwd }
      );
      return { number, closed: true };
    },
  };
}
