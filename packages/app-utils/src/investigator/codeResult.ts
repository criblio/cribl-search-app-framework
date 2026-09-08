/**
 * Decoding for `kind: 'code'` tool results.
 *
 * A server-side tool that reads a file — GoatTown's `read_file` is the
 * one this was written against — answers with
 * `{ kind: 'code', tool, args, body }`, where `body` is the file with a
 * `<lineNo>\t` prefix on every line. Without a renderer for that kind the
 * transcript falls through to whatever the app does with unknown payloads,
 * which in practice is `JSON.stringify` — and a stringified file is one
 * enormously long line of `\n` escapes.
 *
 * The parsing lives apart from the card so it can be tested without a DOM,
 * and so an app writing its own richer code card (syntax highlighting, a
 * link into a repo) can reuse the decode instead of re-deriving it.
 */

import type { CodeResultUi } from '../agent-tools.js';

export type { CodeResultUi };

/** One decoded line: its gutter number, if the body carried one, and the
 *  text with that prefix removed. */
export interface CodeLine {
  no?: number;
  text: string;
}

/**
 * Undo JSON escaping on a body that arrived with it intact.
 *
 * A payload that has been through an extra `JSON.stringify` somewhere on
 * the wire lands here with literal backslash-n instead of newlines, which
 * renders the whole file as a single unreadable line. Only decode when
 * there is no real newline to lose: a body that already has them is being
 * read correctly, and a `\n` inside *that* one is source code — a Go
 * format string, a JS template — that must survive verbatim.
 *
 * The escapes are consumed in one pass so `\\n` (an escaped backslash
 * followed by the letter n) stays a backslash and an n.
 */
export function decodeCodeBody(body: string): string {
  if (body.includes('\n')) return body;
  if (!/\\[nrt\\]/.test(body)) return body;
  return body.replace(/\\([nrt\\])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\',
  );
}

/** `12\tconst x = 1` — the gutter `read_file` prefixes onto each line. */
const GUTTER_RE = /^(\d+)\t([\s\S]*)$/;

/**
 * Split a body into lines, lifting the line-number gutter into its own
 * field.
 *
 * The numbers are only lifted when *every* non-empty line has one.
 * A partial match means the tool didn't emit a gutter and some line of
 * the file merely begins with digits and a tab, and stripping those would
 * silently corrupt the content — TSV data being the obvious way to hit it.
 */
export function parseCodeLines(body: string): CodeLine[] {
  const text = decodeCodeBody(body);
  // No lines at all, so the card can say "empty file" rather than render
  // one blank row that looks like a rendering bug.
  if (text === '') return [];
  // A trailing newline is a terminator, not a blank final line.
  const raw = text.split('\n');
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();

  const matches = raw.map((line) => GUTTER_RE.exec(line));
  const numbered = matches.every((m, i) => m !== null || raw[i] === '');
  if (!numbered || !matches.some((m) => m !== null)) {
    return raw.map((text) => ({ text }));
  }
  return raw.map((line, i) => {
    const m = matches[i];
    return m ? { no: Number(m[1]), text: m[2] } : { text: line };
  });
}

/**
 * Header text for the card: the file path when the args carry one, else
 * the tool name. Malformed args are not worth failing a render over — the
 * body is the point — so a parse failure just falls through.
 */
export function codeResultTitle(ui: CodeResultUi): string {
  let args: unknown = ui.args;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = undefined;
    }
  }
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    for (const key of ['path', 'file', 'filename', 'file_path']) {
      const value = record[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return ui.tool ?? 'Result';
}
