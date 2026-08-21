/**
 * Git write-back, v1: the GitHub Data API backend.
 *
 * The workspace's tarball checkout carries no `.git` state, and this
 * backend needs none: it creates a tree (file contents inline — no
 * per-blob round trips), a commit on top of the checkout's head sha,
 * a branch ref, and a pull request — all plain worker `fetch` against
 * api.github.com. Chosen per the cell-harness extraction design
 * (decision 8): the tool surface stays stable while the backend can
 * later swap to isomorphic-git over the vfs (including a just-bash
 * `git` command wrapping it) when richer git workflows matter.
 */
import type { DirtyFile, RepoOrigin } from './repoStore';

const GITHUB_API = 'https://api.github.com';

export interface OpenPrResult {
  /** The pull request's html_url. */
  url: string;
  branch: string;
  base: string;
  commitSha: string;
}

interface GhOpts {
  token: string;
  signal?: AbortSignal;
}

async function gh<T>(
  method: string,
  path: string,
  { token, signal }: GhOpts,
  body?: unknown,
): Promise<T> {
  const resp = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'criblio-cell-workspace',
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 300);
    throw new Error(`GitHub ${method} ${path} failed (${resp.status}): ${text}`);
  }
  return (await resp.json()) as T;
}

/**
 * Push the workspace's changed files as one commit on a new branch and
 * open a PR against the checkout's base ref.
 *
 * `origin.sha` (head at checkout time) is the preferred parent — the
 * PR then shows exactly the agent's changes even if the base moved
 * since checkout. Falls back to resolving the base ref's current head
 * (checkouts that predate origin-sha tracking).
 */
export async function openPrWithChanges(opts: {
  origin: RepoOrigin;
  files: DirtyFile[];
  branch: string;
  title: string;
  body?: string;
  token: string;
  signal?: AbortSignal;
}): Promise<OpenPrResult> {
  const { origin, files, branch, title, body, token, signal } = opts;
  if (files.length === 0) throw new Error('no changed files to push');
  const ghOpts: GhOpts = { token, signal };
  const repoPath = `/repos/${origin.owner}/${origin.repo}`;

  // Base ref name: the checked-out ref, else the repo's default branch.
  let base = origin.ref;
  if (!base) {
    const repoInfo = await gh<{ default_branch: string }>('GET', repoPath, ghOpts);
    base = repoInfo.default_branch;
  }

  // Parent commit: the checkout's head sha, else the base ref's current head.
  let parentSha = origin.sha;
  if (!parentSha) {
    const ref = await gh<{ object: { sha: string } }>(
      'GET',
      `${repoPath}/git/ref/${encodeURIComponent(`heads/${base}`)}`,
      ghOpts,
    );
    parentSha = ref.object.sha;
  }

  const parent = await gh<{ tree: { sha: string } }>(
    'GET',
    `${repoPath}/git/commits/${parentSha}`,
    ghOpts,
  );

  const tree = await gh<{ sha: string }>('POST', `${repoPath}/git/trees`, ghOpts, {
    base_tree: parent.tree.sha,
    tree: files.map((f) => ({
      path: f.path,
      mode: '100644',
      type: 'blob',
      content: f.content,
    })),
  });

  const commit = await gh<{ sha: string }>('POST', `${repoPath}/git/commits`, ghOpts, {
    message: title,
    tree: tree.sha,
    parents: [parentSha],
  });

  await gh('POST', `${repoPath}/git/refs`, ghOpts, {
    ref: `refs/heads/${branch}`,
    sha: commit.sha,
  });

  const pr = await gh<{ html_url: string }>('POST', `${repoPath}/pulls`, ghOpts, {
    title,
    head: branch,
    base,
    body: body ?? '',
  });

  return { url: pr.html_url, branch, base, commitSha: commit.sha };
}
