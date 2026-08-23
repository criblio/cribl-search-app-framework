/**
 * Turn Cribl's published OpenAPI spec into the compact digest the
 * cribl_api agent tool searches.
 *
 * Run from packages/app-utils:
 *   node scripts/build-openapi-digest.mjs [path-or-url] > src/openapi-digest.json
 *
 * With no argument it fetches the canonical spec from
 * criblio/cribl-openapi-spec@main.
 *
 * WHY A BUILD-TIME DIGEST, not a runtime fetch or a bundled spec:
 *
 *   - `control-plane-v2-full.yml` is 8.1 MB of YAML with ~9,700
 *     unresolved internal $refs. A cell is a workerd isolate: parsing
 *     that per session would eat the handler budget, and there is no
 *     disk to cache it on.
 *   - The resolved variants are ~70 MB, which is worse.
 *   - Fetching at runtime makes every session depend on GitHub being
 *     up and on egress the cell may not have.
 *   - Handing the whole thing to a model is impossible regardless: the
 *     operation index alone is ~125 KB, and the full digest ~650 KB.
 *     The tool therefore SEARCHES the digest and describes one
 *     operation at a time (~2 KB median, ~16 KB worst case).
 *
 * The digest keeps, per operation: method, path, operationId, first
 * tag, summary, parameters (name/in/required/type/description), and the
 * JSON request-body schema with $refs followed. It drops examples,
 * titles, response schemas, and vendor extensions — a model needs to
 * know what to SEND and where; it can read what came back.
 *
 * `x-cribl-internal: true` operations are KEPT, flagged `internal`.
 * They are excluded from the generated SDKs, which is not the same as
 * unusable: the whole `search.metrics` tag is marked internal and it
 * includes `/search/metrics/query`, the endpoint this package's own
 * metrics.ts has always called. Dropping them would hide working
 * endpoints; flagging them lets a model prefer a supported route and
 * still find the one that exists.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';

const SPEC_URL =
  'https://raw.githubusercontent.com/criblio/cribl-openapi-spec/main/specs/control-plane-v2-full.yml';

/** Verbs that carry an operation. `trace` is deliberately absent. */
const VERBS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/** Depth cap on ref-following. Cribl's schemas nest deeply (an output
 *  config is ~8 KB expanded); past this the shape is established and
 *  further detail is noise a model won't use. */
const MAX_DEPTH = 5;

/** Per-operation ceiling. One pathological schema shouldn't be able to
 *  blow a tool result — the describe path returns one of these whole. */
const MAX_OP_BYTES = 24_000;

async function loadSpec(source) {
  if (!source) source = SPEC_URL;
  const text = /^https?:\/\//.test(source)
    ? await fetch(source).then((r) => {
        if (!r.ok) throw new Error(`fetching ${source} → ${r.status}`);
        return r.text();
      })
    : readFileSync(source, 'utf8');
  return YAML.parse(text);
}

function trim(value, max) {
  const s = String(value ?? '')
    .replace(/<\/?code>/g, '`')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Follow $refs and strip noise. Returns undefined for anything that
 * reduced to nothing, so callers can omit the key entirely rather than
 * emit `{}` — across 900 operations those add up.
 */
function resolve(doc, node, depth = 0) {
  if (node == null || typeof node !== 'object') return node;
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(node)) {
    const items = node.slice(0, 40).map((n) => resolve(doc, n, depth + 1));
    return items.length ? items : undefined;
  }
  if (typeof node.$ref === 'string') {
    if (!node.$ref.startsWith('#/')) return undefined;
    let target = doc;
    for (const part of node.$ref.slice(2).split('/')) {
      target = target?.[part?.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    // A dangling ref is a spec bug, not something to crash on — say so
    // in place so the digest stays diffable.
    return target == null ? { unresolvedRef: node.$ref } : resolve(doc, target, depth + 1);
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'example' || key === 'examples' || key === 'title' || key === 'xml') continue;
    if (key.startsWith('x-')) continue;
    if (key === 'description') {
      const d = trim(value, 200);
      if (d) out[key] = d;
      continue;
    }
    const resolved = resolve(doc, value, depth + 1);
    if (resolved !== undefined) out[key] = resolved;
  }
  return Object.keys(out).length ? out : undefined;
}

const doc = await loadSpec(process.argv[2]);

const ops = [];
for (const [path, item] of Object.entries(doc.paths ?? {})) {
  // Path-level parameters apply to every operation on the path.
  const shared = resolve(doc, item?.parameters ?? []) ?? [];
  for (const verb of VERBS) {
    const op = item?.[verb];
    if (!op) continue;
    const params = [...shared, ...(resolve(doc, op.parameters ?? []) ?? [])]
      .filter((p) => p && typeof p === 'object' && p.name)
      .map((p) => ({
        name: p.name,
        in: p.in,
        required: p.required === true ? true : undefined,
        type: p.schema?.type,
        description: p.description,
      }));
    const body = resolve(doc, op.requestBody?.content?.['application/json']?.schema ?? null);
    const entry = {
      method: verb.toUpperCase(),
      path,
      operationId: op.operationId || undefined,
      tag: (op.tags ?? [])[0] || undefined,
      summary: trim(op.summary || op.description, 200) || undefined,
      internal: op['x-cribl-internal'] === true ? true : undefined,
      params: params.length ? params : undefined,
      body: body ?? undefined,
    };
    if (JSON.stringify(entry).length > MAX_OP_BYTES) {
      entry.body = { truncated: 'request body schema too large to include; consult Cribl docs' };
    }
    ops.push(entry);
  }
}

ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const digest = {
  specVersion: doc.info?.version ?? 'unknown',
  generatedFrom: provenance(process.argv[2]),
  ops,
};

/** A URL is reproducible provenance; someone's scratch path is not, so a
 *  local build records only the file name and says it was local. The
 *  `specVersion` beside it is what actually identifies the spec. */
function provenance(source) {
  if (!source) return SPEC_URL;
  if (/^https?:\/\//.test(source)) return source;
  return `${source.split('/').pop()} (local file)`;
}

const json = `${JSON.stringify(digest)}\n`;
if (process.argv[3]) writeFileSync(process.argv[3], json);
else process.stdout.write(json);

process.stderr.write(
  `${ops.length} operations, ${Math.round(json.length / 1024)} KB` +
    ` (spec ${digest.specVersion})\n`,
);
