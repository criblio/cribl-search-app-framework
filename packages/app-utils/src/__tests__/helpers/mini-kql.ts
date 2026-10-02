/**
 * A tiny evaluator for the scalar KQL subset the framework emits for state
 * machines: `case`, `iff`, `not`, `isnotempty`, `and`, `or`, `==`, `>=`,
 * `+`, string/integer/boolean literals and column references, plus
 * `| extend a=<expr>, b=<expr>` stages. Enough to execute generated KQL
 * against the same table a TypeScript function is tested with, so a test
 * can assert the two agree without a live Cribl workspace.
 */

type Value = string | number | boolean | null;
type Row = Record<string, Value>;

type Token =
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'id'; value: string }
  | { kind: 'op'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (src[j] !== '"') {
        if (j >= src.length) throw new Error('unterminated string');
        if (src[j] === '\\') { out += src[j + 1]; j += 2; continue; }
        out += src[j];
        j += 1;
      }
      tokens.push({ kind: 'str', value: out });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '>=') { tokens.push({ kind: 'op', value: two }); i += 2; continue; }
    if ('(),+'.includes(c)) { tokens.push({ kind: 'op', value: c }); i += 1; continue; }
    const num = /^\d+/.exec(src.slice(i));
    if (num) { tokens.push({ kind: 'num', value: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { tokens.push({ kind: 'id', value: id[0] }); i += id[0].length; continue; }
    throw new Error(`unexpected character ${JSON.stringify(c)} in ${JSON.stringify(src)}`);
  }
  return tokens;
}

type Node = (row: Row) => Value;

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.or();
    if (this.pos !== this.tokens.length) throw new Error(`trailing tokens at ${this.pos}`);
    return node;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private isOp(value: string): boolean {
    const t = this.peek();
    return t?.kind === 'op' && t.value === value;
  }
  private isWord(value: string): boolean {
    const t = this.peek();
    return t?.kind === 'id' && t.value === value;
  }
  private expectOp(value: string): void {
    if (!this.isOp(value)) throw new Error(`expected ${value} at ${this.pos}`);
    this.pos += 1;
  }

  private or(): Node {
    let left = this.and();
    while (this.isWord('or')) {
      this.pos += 1;
      const l = left; const r = this.and();
      left = (row) => Boolean(l(row)) || Boolean(r(row));
    }
    return left;
  }

  private and(): Node {
    let left = this.cmp();
    while (this.isWord('and')) {
      this.pos += 1;
      const l = left; const r = this.cmp();
      left = (row) => Boolean(l(row)) && Boolean(r(row));
    }
    return left;
  }

  private cmp(): Node {
    const left = this.sum();
    if (this.isOp('==') || this.isOp('>=')) {
      const op = (this.tokens[this.pos] as { value: string }).value;
      this.pos += 1;
      const right = this.sum();
      // KQL comparisons against null are false, never an error.
      return op === '=='
        ? (row) => { const a = left(row); const b = right(row); return a !== null && b !== null && a === b; }
        : (row) => { const a = left(row); const b = right(row); return a !== null && b !== null && Number(a) >= Number(b); };
    }
    return left;
  }

  private sum(): Node {
    let left = this.atom();
    while (this.isOp('+')) {
      this.pos += 1;
      const l = left; const r = this.atom();
      left = (row) => Number(l(row)) + Number(r(row));
    }
    return left;
  }

  private args(): Node[] {
    this.expectOp('(');
    const out: Node[] = [];
    if (!this.isOp(')')) {
      out.push(this.or());
      while (this.isOp(',')) { this.pos += 1; out.push(this.or()); }
    }
    this.expectOp(')');
    return out;
  }

  private atom(): Node {
    const t = this.peek();
    if (!t) throw new Error('unexpected end');
    if (t.kind === 'str' || t.kind === 'num') { this.pos += 1; const v = t.value; return () => v; }
    if (t.kind === 'op' && t.value === '(') {
      this.pos += 1;
      const inner = this.or();
      this.expectOp(')');
      return inner;
    }
    if (t.kind !== 'id') throw new Error(`unexpected token ${t.value}`);
    this.pos += 1;
    if (t.value === 'true') return () => true;
    if (t.value === 'false') return () => false;
    if (!this.isOp('(')) {
      const name = t.value;
      return (row) => {
        if (!(name in row)) throw new Error(`unknown column ${name}`);
        return row[name];
      };
    }
    const a = this.args();
    switch (t.value) {
      case 'case':
        if (a.length % 2 !== 1) throw new Error('case() needs an odd argument count');
        return (row) => {
          for (let i = 0; i + 1 < a.length; i += 2) if (a[i](row) === true) return a[i + 1](row);
          return a[a.length - 1](row);
        };
      case 'iff':
        return (row) => (a[0](row) === true ? a[1](row) : a[2](row));
      case 'not':
        return (row) => !a[0](row);
      case 'isnotempty':
        return (row) => { const v = a[0](row); return v !== null && v !== ''; };
      default:
        throw new Error(`unsupported function ${t.value}`);
    }
  }
}

export function evalKqlExpr(expr: string, row: Row): Value {
  return new Parser(tokenize(expr)).parse()(row);
}

/** Split at commas outside parentheses and string literals. */
function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0; let inStr = false; let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inStr) { if (c === '\\') i += 1; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(src.slice(start, i)); start = i + 1; }
  }
  parts.push(src.slice(start));
  return parts;
}

/** Run `| extend` stages over one row. Assignments in a stage see the row
 * as it was before the stage, as in KQL. */
export function runExtendStages(kql: string, input: Row): Row {
  let row = { ...input };
  const stages = kql.split(/^\s*\|\s*/m).map((s) => s.trim()).filter(Boolean);
  for (const stage of stages) {
    if (!stage.startsWith('extend ')) throw new Error(`unsupported stage: ${stage.slice(0, 30)}`);
    const before = row;
    const next = { ...row };
    for (const assignment of splitTopLevel(stage.slice('extend '.length))) {
      const eq = assignment.indexOf('=');
      const name = assignment.slice(0, eq).trim();
      next[name] = evalKqlExpr(assignment.slice(eq + 1), before);
    }
    row = next;
  }
  return row;
}
