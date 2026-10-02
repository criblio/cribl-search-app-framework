/**
 * Post-reconcile canary: are the provisioned searches actually producing?
 *
 * The plan guard (`/provision-guard`) catches static faults before apply.
 * This catches their runtime equivalents, which every API layer reports
 * as success:
 *
 *   1. Sentinel — a scheduled search the app depends on has rows in
 *      `$vt_results`. A search wiped to `dataset=""` runs on schedule,
 *      "succeeds", and writes nothing; only reading its output shows it.
 *   2. Lookup join — a lookup the app joins really matches sampled keys.
 *      An unjoinable CSV written by `export to lookup` reported success
 *      everywhere; the only test is to try the join.
 *   3. Extra probes — app-specific round trips.
 *
 * First install: scheduled searches have not run, so `$vt_results` is
 * genuinely empty and lookups hold only their seed row. `firstInstall`
 * downgrades "empty" to a tolerated pass (`tolerated: true`) — never a
 * query error, which fails regardless.
 */
import { kqlStringLiteral } from './kql.js';
import { runSearchJob, type SearchHttpClient } from './search-job.js';

/** The outcome of one probe. */
export interface ProvisionProbeResult {
  name: string;
  ok: boolean;
  /** True when `ok` only because `firstInstall` tolerated an empty result. */
  tolerated: boolean;
  rowCount: number;
  message: string;
}

export interface ProvisionCanaryReport {
  ok: boolean;
  probes: ProvisionProbeResult[];
}

/** Context handed to an extra probe. */
export interface ProvisionProbeContext {
  firstInstall: boolean;
  /** Runs one search job with the canary's timeout. */
  query(kql: string, earliest?: string, latest?: string): Promise<Record<string, unknown>[]>;
}

export interface ProvisionCanaryProbe {
  name: string;
  run(ctx: ProvisionProbeContext): Promise<Omit<ProvisionProbeResult, 'name'>>;
}

export interface ProvisionCanaryLookupProbe {
  /** The lookup's name, for messages. */
  name: string;
  /**
   * Must return ONE row with numeric `total` (keys sampled) and `joined`
   * (keys the lookup matched), e.g.
   * `dataset="otel" | take 50 | lookup my_lookup on svc
   *   | summarize total=count(), joined=countif(isnotnull(<lookup column>))`.
   * Sample keys from live data rather than naming a fixed one — no static
   * key is guaranteed to be in the lookup on every workspace.
   */
  kql: string;
  /** Default `'-15m'`. */
  earliest?: string;
}

export interface ProvisionCanaryOptions {
  /** The scheduled search whose `$vt_results` rows prove the pipeline
   * runs. Pick the highest-cadence, highest-volume one. */
  sentinelSearchId: string;
  /** Default `'-2h'`: spans the cadence a few times so one late run
   * does not flap the canary. */
  sentinelWindow?: string;
  lookupProbe?: ProvisionCanaryLookupProbe;
  extraProbes?: ProvisionCanaryProbe[];
  /** Tolerate empty results (searches have not run yet). */
  firstInstall?: boolean;
  /** Per search job. Default 45 s. */
  timeoutMs?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the canary's probes. Never throws for a failed probe — a probe
 * whose query fails is reported `ok: false`.
 *
 * ```ts
 * const report = await runProvisionCanary(http, {
 *   sentinelSearchId: 'myapp__summary',
 *   lookupProbe: { name: 'myapp_owners', kql: OWNERS_JOIN_PROBE },
 *   firstInstall: isFirstInstall,
 * });
 * if (!report.ok) process.exit(1);
 * ```
 */
export async function runProvisionCanary(
  http: SearchHttpClient,
  opts: ProvisionCanaryOptions,
): Promise<ProvisionCanaryReport> {
  const firstInstall = opts.firstInstall ?? false;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const query = (kql: string, earliest = '-15m', latest = 'now') =>
    runSearchJob(http, kql, { earliest, latest, limit: 100, timeoutMs });
  const probes: ProvisionProbeResult[] = [];

  // 1. Sentinel.
  const sentinelId = opts.sentinelSearchId;
  const sentinelWindow = opts.sentinelWindow ?? '-2h';
  const name = `sentinel ${sentinelId}`;
  try {
    const rows = await query(
      `dataset="$vt_results" | where jobName == ${kqlStringLiteral(sentinelId)} | limit 1`,
      sentinelWindow,
    );
    if (rows.length > 0) {
      probes.push({ name, ok: true, tolerated: false, rowCount: rows.length, message: `$vt_results has rows in ${sentinelWindow}` });
    } else if (firstInstall) {
      probes.push({ name, ok: true, tolerated: true, rowCount: 0, message: 'no $vt_results rows yet — tolerated on first install' });
    } else {
      probes.push({
        name,
        ok: false,
        tolerated: false,
        rowCount: 0,
        message: `ZERO $vt_results rows in ${sentinelWindow}: the search is not running, or runs and reads nothing (check for dataset="")`,
      });
    }
  } catch (err) {
    probes.push({ name, ok: false, tolerated: false, rowCount: 0, message: `sentinel query failed: ${errorMessage(err)}` });
  }

  // 2. Lookup join.
  if (opts.lookupProbe) {
    probes.push(await lookupJoinProbe(opts.lookupProbe, firstInstall, query));
  }

  // 3. App-specific probes.
  for (const probe of opts.extraProbes ?? []) {
    try {
      probes.push({ name: probe.name, ...(await probe.run({ firstInstall, query })) });
    } catch (err) {
      probes.push({ name: probe.name, ok: false, tolerated: false, rowCount: 0, message: `probe failed: ${errorMessage(err)}` });
    }
  }

  return { ok: probes.every((p) => p.ok), probes };
}

async function lookupJoinProbe(
  probe: ProvisionCanaryLookupProbe,
  firstInstall: boolean,
  query: ProvisionProbeContext['query'],
): Promise<ProvisionProbeResult> {
  const name = `lookup ${probe.name}`;
  const fail = (rowCount: number, message: string): ProvisionProbeResult =>
    ({ name, ok: false, tolerated: false, rowCount, message });
  const tolerate = (rowCount: number, message: string): ProvisionProbeResult =>
    ({ name, ok: true, tolerated: true, rowCount, message: `${message} — tolerated on first install` });
  let rows: Record<string, unknown>[];
  try {
    rows = await query(probe.kql, probe.earliest ?? '-15m');
  } catch (err) {
    return fail(0, `lookup probe query failed: ${errorMessage(err)}`);
  }
  const row = rows[0];
  const total = Number(row?.total ?? 0);
  const joined = Number(row?.joined ?? 0);
  if (!row || !Number.isFinite(total) || total <= 0) {
    return firstInstall
      ? tolerate(rows.length, 'no keys to sample')
      : fail(rows.length, 'no keys to sample in the probe window — is data flowing?');
  }
  if (joined > 0) {
    return { name, ok: true, tolerated: false, rowCount: rows.length, message: `joinable (${joined}/${total} sampled keys matched)` };
  }
  return firstInstall
    ? tolerate(rows.length, `${total} keys sampled, 0 joined (lookup not populated yet)`)
    : fail(
        rows.length,
        `${total} sampled keys, ZERO joined — the lookup is unjoinable (e.g. written through a (?i) regex) or its search never populated it`,
      );
}
