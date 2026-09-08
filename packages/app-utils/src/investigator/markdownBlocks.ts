/**
 * Block segmentation for the transcript's markdown renderer.
 *
 * The renderer used to split a text run on blank lines and treat every
 * piece as a paragraph, which handles prose and tables but silently
 * mangles the two things an agent writes most: `## headings` came out as
 * literal hashes, and a bullet list collapsed into one run-on paragraph.
 * A report built out of headings and nested bullets — which is what a
 * `kind: 'report'` payload is — was unreadable even once it reached a
 * card.
 *
 * Segmentation lives here, apart from the JSX, so the line-level rules
 * can be tested without a DOM. It imports no CSS, so it stays safe to
 * share across entry points (see `scripts/check-css-build.mjs`).
 */

export interface MarkdownListItem {
  text: string;
  /** Nested items, from lines indented under this one. */
  children: MarkdownListItem[];
}

export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | { kind: 'paragraph'; text: string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
/** Indent at or beyond this is a child of the item above it. */
const NEST_INDENT = 2;

/**
 * Split one markdown text run into blocks.
 *
 * Paragraphs still end at a blank line, but a blank line inside a list
 * does not end the list: agents routinely put one between numbered items,
 * and treating it as a terminator produced a separate single-item list per
 * entry, each restarting at "1.".
 */
export function splitBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: MarkdownListItem[] } | null = null;

  const flushParagraph = () => {
    const body = paragraph.join('\n').trim();
    if (body) blocks.push({ kind: 'paragraph', text: body });
    paragraph = [];
  };
  const flushList = () => {
    if (list && list.items.length > 0) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    }
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === '') {
      // A blank line ends a paragraph always, but ends a list only if the
      // list does not resume after it.
      flushParagraph();
      if (list) {
        const next = lines.slice(i + 1).find((l) => l.trim() !== '');
        if (!next || !LIST_RE.test(next)) flushList();
      }
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const item = LIST_RE.exec(line);
    if (item) {
      flushParagraph();
      const [, indent, marker, body] = item;
      const ordered = !/^[-*+]$/.test(marker);
      if (!list) list = { ordered, items: [] };
      const parent = list.items[list.items.length - 1];
      if (indent.length >= NEST_INDENT && parent) {
        parent.children.push({ text: body.trim(), children: [] });
      } else {
        list.items.push({ text: body.trim(), children: [] });
      }
      continue;
    }

    // A non-blank, non-marker line while a list is open continues the
    // text of the item above it rather than silently starting a paragraph
    // in the middle of the list.
    if (list && /^\s/.test(line)) {
      const parent = list.items[list.items.length - 1];
      const target = parent?.children[parent.children.length - 1] ?? parent;
      if (target) {
        target.text = `${target.text} ${line.trim()}`;
        continue;
      }
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}
