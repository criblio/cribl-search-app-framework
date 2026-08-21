/**
 * Write tools for the workspace: write_file / edit_file over the
 * RepoStore (dirty-tracked), and open_pr — the git write-back that
 * turns the accumulated changes into a branch + pull request
 * (gitPush.ts, GitHub Data API backend).
 *
 * OFFERED PER PAYLOAD. The read-only set (codeTools.ts) is what the
 * alert-triggered APM investigator advertises — least privilege for an
 * autonomous agent was a deliberate scoping decision there, not an
 * architectural limit. A coding payload composes both sets.
 *
 * Same executor contract as the read tools: failures are explanatory
 * `content` the model can react to, never thrown errors.
 */
import type { AgentToolDefinition } from '@cribl/app-utils/agent';
import type {
  ToolCallInvocation,
  ToolExecutionResult,
} from '@cribl/app-utils/agent-tools';
import type { RepoStore } from './repoStore';
import { openPrWithChanges } from './gitPush';

export const WRITE_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    id: 'write_file',
    description:
      'Create or overwrite one file in a checked-out repo. The change stays in the workspace until open_pr pushes it. For small targeted changes to an existing file, prefer edit_file.',
    schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name returned by checkout_repo.' },
        path: { type: 'string', description: 'File path within the repo.' },
        content: { type: 'string', description: 'The complete new file content.' },
      },
      required: ['repo', 'path', 'content'],
    },
  },
  {
    id: 'edit_file',
    description:
      'Replace one exact string in a file with another. old_string must appear exactly once (include enough surrounding lines to make it unique). The change stays in the workspace until open_pr pushes it.',
    schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name returned by checkout_repo.' },
        path: { type: 'string', description: 'File path within the repo.' },
        old_string: { type: 'string', description: 'Exact text to replace (must be unique in the file).' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['repo', 'path', 'old_string', 'new_string'],
    },
  },
  {
    id: 'open_pr',
    description:
      'Push every file changed in this session as one commit on a new branch and open a GitHub pull request. Call once, after your changes are complete. Returns the PR URL.',
    schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name returned by checkout_repo.' },
        title: { type: 'string', description: 'PR title (also the commit message).' },
        body: { type: 'string', description: 'PR description (markdown). Explain the why.' },
        branch: {
          type: 'string',
          description: 'Branch name to create (optional; derived from the title when omitted).',
        },
      },
      required: ['repo', 'title'],
    },
  },
];

export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(
  WRITE_TOOL_DEFINITIONS.map((d) => d.id),
);

/** Derive a branch name from a PR title: `cell/<slug>-<time36>`. */
function branchFromTitle(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'change';
  return `cell/${slug}-${Date.now().toString(36)}`;
}

export interface WriteToolDeps {
  store: RepoStore;
  /** GitHub token for open_pr (repo scope). Absent ⇒ open_pr explains
   *  it cannot push instead of failing the turn. */
  token?: string;
}

export function createWriteToolExecutors(deps: WriteToolDeps): {
  names: ReadonlySet<string>;
  executeToolCall(call: ToolCallInvocation, signal?: AbortSignal): Promise<ToolExecutionResult>;
} {
  async function executeToolCall(
    call: ToolCallInvocation,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const args = (() => {
      try {
        return JSON.parse(call.arguments || '{}') as Record<string, string | undefined>;
      } catch {
        return {};
      }
    })();
    // Same `code` ui card the read tools use, so the transcript renders
    // write activity like any other tool use.
    const done = (content: string): ToolExecutionResult => ({
      id: call.id,
      name: call.name,
      content,
      ui: {
        kind: 'code',
        tool: call.name,
        args: call.arguments ?? '',
        body: content.length > 4000 ? `${content.slice(0, 4000)}\n… (truncated)` : content,
      } as unknown as ToolExecutionResult['ui'],
    });

    const repo = args.repo ?? '';
    if (!deps.store.hasRepo(repo)) {
      return done(`Repo "${repo}" is not checked out. Call checkout_repo first.`);
    }

    try {
      switch (call.name) {
        case 'write_file': {
          const path = args.path ?? '';
          const content = args.content;
          if (!path || content == null) return done('write_file needs path and content.');
          const existed = deps.store.readFile(repo, path) != null;
          deps.store.agentWrite(repo, path, content);
          return done(
            `${existed ? 'Overwrote' : 'Created'} ${path} (${content.length} bytes). It will ride the next open_pr.`,
          );
        }
        case 'edit_file': {
          const path = args.path ?? '';
          const oldStr = args.old_string;
          const newStr = args.new_string;
          if (!path || oldStr == null || newStr == null) {
            return done('edit_file needs path, old_string, and new_string.');
          }
          if (oldStr === newStr) return done('old_string and new_string are identical — nothing to do.');
          if (!oldStr) return done('old_string must not be empty (use write_file to create a file).');
          const current = deps.store.readFile(repo, path);
          if (current == null) {
            return done(`${path} does not exist in "${repo}". Use write_file to create it.`);
          }
          const count = current.split(oldStr).length - 1;
          if (count === 0) {
            return done(
              `old_string was not found in ${path}. Read the file and copy the exact text (whitespace matters).`,
            );
          }
          if (count > 1) {
            return done(
              `old_string appears ${count} times in ${path} — include more surrounding context so it is unique.`,
            );
          }
          deps.store.agentWrite(repo, path, current.replace(oldStr, newStr));
          return done(`Edited ${path}. It will ride the next open_pr.`);
        }
        case 'open_pr': {
          const title = (args.title ?? '').trim();
          if (!title) return done('open_pr needs a title.');
          if (!deps.token) {
            return done(
              'No GitHub token is configured on this cell (GITHUB_TOKEN), so changes cannot be pushed. Summarize your proposed changes as diffs in the conversation instead.',
            );
          }
          const origin = deps.store.origin(repo);
          if (!origin) {
            return done(
              `No push origin recorded for "${repo}" (checkout predates origin tracking). Re-run checkout_repo, re-apply the changes, then open_pr.`,
            );
          }
          const files = deps.store.dirtyFiles(repo);
          if (files.length === 0) {
            return done('No files have been changed in this session — nothing to push.');
          }
          const branch = (args.branch ?? '').trim() || branchFromTitle(title);
          const result = await openPrWithChanges({
            origin,
            files,
            branch,
            title,
            body: args.body,
            token: deps.token,
            signal,
          });
          return done(
            `Opened ${result.url} (branch ${result.branch} → ${result.base}, ${files.length} file${files.length === 1 ? '' : 's'}: ${files.map((f) => f.path).join(', ')}).`,
          );
        }
        default:
          return done(`Unknown write tool "${call.name}".`);
      }
    } catch (err) {
      return done(`${call.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { names: WRITE_TOOL_NAMES, executeToolCall };
}
