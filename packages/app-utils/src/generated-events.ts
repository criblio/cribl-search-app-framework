/**
 * Durable app-generated events: alerts, deploy markers, lifecycle records —
 * anything a scheduled search or an app writes back into a dataset so it
 * survives as queryable history.
 *
 * Three rules, each learned the hard way in Cribl APM:
 *
 * - **Write with `| export tee=true to search "<dataset>"`.** The older
 *   `| send group="search"` path silently stopped persisting: the job
 *   completes, nothing lands. `tee=true` also passes the rows through to
 *   `$vt_results`, so the same search feeds the UI.
 * - **Read the datatype through both columns.** `export` keeps the projected
 *   `datatype`; rows written by `send` landed with it renamed to
 *   `data_datatype` (and the search-time `datatype` reclassified as
 *   "Uncategorized"). {@link STORED_DATATYPE_EXPR} coalesces the two so one
 *   reader spans the migration.
 * - **Prove the round trip.** A static query check cannot see routing or
 *   normalization drift; a canary written through the real boundary and read
 *   back through the real predicate can. {@link runGeneratedEventCanary}.
 *
 * A subpath of its own rather than part of `/kql`: `/kql` is the context-free
 * serialization boundary, while this module owns a storage *contract*
 * (schema version, datatype names, a canary runner) built on top of it.
 */

import { KqlSafetyError, kqlDatasetId, kqlInteger, kqlStringLiteral } from './kql.js';

/** Datatype as stored, for rows written by `export` (`datatype`) and by the
 * retired `send` path (`data_datatype`). */
export const STORED_DATATYPE_EXPR = 'coalesce(tostring(data_datatype), tostring(datatype))';

const DATATYPE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CANARY_ID = /^[A-Za-z0-9_-]{1,96}$/;

function datatypeName(value: string): string {
  if (!DATATYPE.test(value)) throw new KqlSafetyError(`unsupported generated-event datatype: ${value}`);
  return value;
}

function column(value: string): string {
  if (!COLUMN.test(value)) throw new KqlSafetyError(`not a plain column name: ${value}`);
  return value;
}

/** `<stored datatype> == "x"` or `in ("x", "y")`. */
export function storedDatatypePredicate(datatypes: string | readonly string[]): string {
  const list = (typeof datatypes === 'string' ? [datatypes] : [...datatypes]).map(datatypeName);
  if (list.length === 0) throw new KqlSafetyError('at least one datatype is required');
  return list.length === 1
    ? `${STORED_DATATYPE_EXPR} == ${kqlStringLiteral(list[0])}`
    : `${STORED_DATATYPE_EXPR} in (${list.map(kqlStringLiteral).join(', ')})`;
}

/**
 * A stable logical id: `event_id` when the producer wrote one, else
 * `legacy:<f1>:<f2>…` from fields that identify the row. Dedupe on this so a
 * row from before `event_id` existed is still counted once.
 */
export function eventIdExpr(fallbackFields: readonly string[], idField = 'event_id'): string {
  if (fallbackFields.length === 0) throw new KqlSafetyError('eventIdExpr needs at least one fallback field');
  const pieces = fallbackFields.map((f) => `tostring(${column(f)})`).join(', ":", ');
  return `coalesce(tostring(${column(idField)}), strcat("legacy:", ${pieces}))`;
}

/** The write boundary: `| export tee=true to search "<dataset>"`. */
export function exportToSearchClause(dataset: string): string {
  return `| export tee=true to search ${kqlStringLiteral(kqlDatasetId(dataset))}`;
}

export type CanaryFieldValue = string | number | boolean;

export interface GeneratedEventsConfig<D extends string> {
  /** Every datatype the app writes. Readers and the canary cover exactly these. */
  datatypes: readonly D[];
  /** Written as `schema_version` on every event; bump it on a breaking shape change. */
  schemaVersion: number;
  /** `producer` on canary rows, so they are distinguishable from real producers. */
  canaryProducer: string;
  /** Extra columns per datatype on its canary row — make each canary look like
   * a real event so a reader that filters on those columns still sees it. */
  canaryFields?: Partial<Record<D, Record<string, CanaryFieldValue>>>;
}

export interface CanaryVerdict {
  ok: boolean;
  rows: number;
  types: number;
  versions: number;
  canaries: number;
  message: string;
}

export interface GeneratedEvents<D extends string> {
  readonly datatypes: readonly D[];
  readonly schemaVersion: number;
  /** Predicate over the stored datatype; throws for a datatype not in the contract. */
  predicate(datatypes: D | readonly D[]): string;
  /** KQL that writes one canary row per datatype through the real export boundary. */
  canarySend(canaryId: string, dataset: string): string;
  /** KQL that reads the canaries back through the consumers' predicate; one summary row. */
  canaryRead(canaryId: string, dataset: string): string;
  /** Judge the `canaryRead` result: every datatype back, one schema version. */
  canaryVerdict(rows: readonly Record<string, unknown>[]): CanaryVerdict;
}

const RESERVED = new Set(['datatype', 'schema_version', 'event_id', 'producer', 'is_canary', 'dataset', '_time']);

function canaryValue(value: CanaryFieldValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? `tolong(${kqlInteger(value)})` : `toreal(${String(value)})`;
  }
  return kqlStringLiteral(value);
}

function canaryId(value: string): string {
  if (!CANARY_ID.test(value)) {
    throw new KqlSafetyError('canary ID must contain only letters, digits, underscores, and dashes');
  }
  return value;
}

/** Bind an app's datatypes and schema version into reader, writer and canary helpers. */
export function defineGeneratedEvents<const D extends string>(
  config: GeneratedEventsConfig<D>,
): GeneratedEvents<D> {
  const datatypes = [...config.datatypes];
  if (datatypes.length === 0) throw new KqlSafetyError('at least one datatype is required');
  datatypes.forEach(datatypeName);
  if (new Set(datatypes).size !== datatypes.length) throw new KqlSafetyError('datatypes must be unique');
  const schemaVersion = kqlInteger(config.schemaVersion, { min: 1 });
  const producer = kqlStringLiteral(config.canaryProducer);
  for (const fields of Object.values(config.canaryFields ?? {}) as Record<string, CanaryFieldValue>[]) {
    for (const [name, value] of Object.entries(fields)) {
      column(name);
      if (RESERVED.has(name)) throw new KqlSafetyError(`canary field ${name} is set by the contract`);
      if (typeof value === 'number' && !Number.isFinite(value)) throw new KqlSafetyError(`canary field ${name} is not finite`);
    }
  }
  const known = new Set<string>(datatypes);
  const eventId = (id: string, dt: string) => kqlStringLiteral(`${id}:${dt}`);

  return {
    datatypes,
    schemaVersion: config.schemaVersion,

    predicate(selected) {
      const list = typeof selected === 'string' ? [selected] : [...selected];
      for (const dt of list) {
        if (!known.has(dt)) throw new KqlSafetyError(`unsupported generated-event datatype: ${dt}`);
      }
      return storedDatatypePredicate(list);
    },

    canarySend(rawId, rawDataset) {
      const id = canaryId(rawId);
      const dataset = kqlStringLiteral(kqlDatasetId(rawDataset));
      const rows = datatypes.map((dt) => {
        const extra = Object.entries(config.canaryFields?.[dt] ?? {})
          .map(([name, value]) => `, ${name}=${canaryValue(value)}`)
          .join('');
        return `print datatype=${kqlStringLiteral(dt)}, schema_version=tolong(${schemaVersion}), ` +
          `event_id=${eventId(id, dt)}, producer=${producer}, dataset=${dataset}, is_canary=true${extra}`;
      });
      const [first, ...rest] = rows;
      return [first, ...rest.map((row) => `| union (${row})`), exportToSearchClause(rawDataset)].join('\n');
    },

    canaryRead(rawId, rawDataset) {
      const id = canaryId(rawId);
      const dataset = kqlStringLiteral(kqlDatasetId(rawDataset));
      return [
        `dataset=${dataset}`,
        `| where event_id in (${datatypes.map((dt) => eventId(id, dt)).join(', ')})`,
        `| where ${storedDatatypePredicate(datatypes)}`,
        `| summarize rows=count(), types=dcount(${STORED_DATATYPE_EXPR}), ` +
          `versions=dcount(tolong(schema_version)), canaries=countif(tostring(is_canary)=="true")`,
      ].join('\n');
    },

    canaryVerdict(result) {
      const row = result[0] ?? {};
      const num = (key: string) => Number(row[key] ?? 0) || 0;
      const rows = num('rows'); const types = num('types');
      const versions = num('versions'); const canaries = num('canaries');
      const n = datatypes.length;
      const ok = rows >= n && types === n && versions === 1 && canaries >= n;
      return {
        ok, rows, types, versions, canaries,
        message: ok
          ? `generated-event round trip passed (${rows} rows, ${types} datatypes, schema v${config.schemaVersion})`
          : `generated-event contract drift: expected ${n} canary rows across ${n} datatypes at one schema version; ` +
            `got rows=${rows}, types=${types}, versions=${versions}, canaries=${canaries}`,
      };
    },
  };
}

export interface GeneratedEventCanaryOptions {
  dataset: string;
  /** Defaults to a random `canary-<base36>` id. */
  canaryId?: string;
  /** Read attempts while the written rows become searchable. Default 8. */
  attempts?: number;
  /** Delay between read attempts. Default 1000 ms. */
  pollMs?: number;
  signal?: AbortSignal;
}

/** Runs one query over [earliest, latest] and returns its rows. */
export type CanaryQueryRunner = (
  kql: string,
  earliest: string,
  latest: string,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>[]>;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Write the canaries, then poll the read until every datatype is back or
 * the attempts run out. Never throws for drift — a failed round trip is a
 * verdict (`ok: false`) with the counts that explain it. Query failures and
 * aborts do throw.
 */
export async function runGeneratedEventCanary<D extends string>(
  events: GeneratedEvents<D>,
  run: CanaryQueryRunner,
  opts: GeneratedEventCanaryOptions,
): Promise<CanaryVerdict & { canaryId: string }> {
  const id = opts.canaryId ?? `canary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const attempts = Math.max(1, opts.attempts ?? 8);
  const pollMs = Math.max(0, opts.pollMs ?? 1_000);
  await run(events.canarySend(id, opts.dataset), '-1m', 'now', opts.signal);
  let verdict = events.canaryVerdict([]);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    verdict = events.canaryVerdict(await run(events.canaryRead(id, opts.dataset), '-15m', 'now', opts.signal));
    if (verdict.ok) break;
    if (attempt + 1 < attempts) await sleep(pollMs, opts.signal);
  }
  return { ...verdict, canaryId: id };
}
