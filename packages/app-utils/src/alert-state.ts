/**
 * Debounced alert state machine, as ONE pure TypeScript function and the
 * KQL that runs the same machine inside a scheduled search.
 *
 *   ok → pending → firing → resolving → ok
 *
 * plus two back-edges: pending → ok (a flap that never fired) and
 * resolving → firing (a relapse during clear-out).
 *
 * Production evaluation happens in KQL — a scheduled evaluator reads the
 * last persisted evaluation, applies `case()`, and writes the next one —
 * while the UI, tests and tooling reason in TypeScript. Two hand-written
 * copies drift: Cribl APM carried two TS copies beside its KQL, and one of
 * them reset counters the evaluator keeps. So the KQL here is GENERATED
 * from the same arm table `nextAlertState` walks, and the tests evaluate
 * the emitted KQL against the TS for every transition.
 *
 * Counter semantics follow the evaluator: `newBad`/`newGood` include the
 * current evaluation (`newBad = isBad ? prevBad + 1 : 0`), and counters are
 * never reset on a transition — they are recomputed from `isBad` alone.
 */

import { KqlSafetyError, kqlInteger } from './kql.js';

export type AlertStatus = 'ok' | 'pending' | 'firing' | 'resolving';
/** `firing` on pending→firing, `resolved` on resolving→ok, else `''`. */
export type AlertTransition = '' | 'firing' | 'resolved';

export const ALERT_STATUSES: readonly AlertStatus[] = ['ok', 'pending', 'firing', 'resolving'];

export interface AlertDebounce {
  /** Consecutive bad evaluations (including the one that entered pending)
   * before pending promotes to firing. ok→pending always takes one
   * evaluation, so values 1 and 2 both fire on the second bad evaluation. */
  fireAfter: number;
  /** Consecutive good evaluations (including the one that entered
   * resolving) before resolving clears to ok. */
  clearAfter: number;
}

export const DEFAULT_ALERT_DEBOUNCE: Readonly<AlertDebounce> = { fireAfter: 2, clearAfter: 3 };

export interface AlertStateInput {
  /** Status from the prior evaluation. `null`/`undefined`/`''` (no prior
   * row) means `ok`. Any other unrecognised value falls through to `ok`, exactly
   * as the KQL `case()` default arm does. */
  prevStatus: AlertStatus | string | null | undefined;
  isBad: boolean;
  /** Consecutive bad evaluations including this one. */
  newBad: number;
  /** Consecutive good evaluations including this one. */
  newGood: number;
}

export interface AlertStateResult {
  status: AlertStatus;
  transitionedTo: AlertTransition;
  /** 1 on pending→firing only; a resolving→firing relapse is not a new fire. */
  fireCountDelta: 0 | 1;
}

/** `newBad`/`newGood` from the previous counters, as the evaluator computes them. */
export function nextAlertCounters(
  isBad: boolean,
  prevBad: number,
  prevGood: number,
): { newBad: number; newGood: number } {
  return isBad ? { newBad: prevBad + 1, newGood: 0 } : { newBad: 0, newGood: prevGood + 1 };
}

// ── The single arm table ─────────────────────────────────────────────
// Each arm is evaluated in order; the first match wins; the default is ok.
// Both nextAlertState and the KQL emitters walk this table, so the two
// cannot disagree about order, guards or thresholds.

type Guard = 'fire' | 'clear' | null;

interface Arm {
  bad: boolean;
  prev: AlertStatus;
  guard: Guard;
  next: AlertStatus;
}

const ARMS: readonly Arm[] = [
  { bad: true, prev: 'ok', guard: null, next: 'pending' },
  { bad: true, prev: 'pending', guard: 'fire', next: 'firing' },
  { bad: true, prev: 'pending', guard: null, next: 'pending' },
  { bad: true, prev: 'firing', guard: null, next: 'firing' },
  { bad: true, prev: 'resolving', guard: null, next: 'firing' },
  { bad: false, prev: 'pending', guard: null, next: 'ok' },
  { bad: false, prev: 'firing', guard: null, next: 'resolving' },
  { bad: false, prev: 'resolving', guard: 'clear', next: 'ok' },
  { bad: false, prev: 'resolving', guard: null, next: 'resolving' },
];

/** The arm guarded by fireAfter is the only fire; the clearAfter arm the only resolve. */
const FIRE_ARM = ARMS[1];
const CLEAR_ARM = ARMS[7];

function validDebounce(debounce: AlertDebounce): AlertDebounce {
  for (const [name, value] of Object.entries(debounce)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
      throw new RangeError(`${name} must be an integer between 1 and 1000`);
    }
  }
  return debounce;
}

function armMatches(arm: Arm, input: AlertStateInput, prev: string, d: AlertDebounce): boolean {
  if (arm.bad !== input.isBad || arm.prev !== prev) return false;
  if (arm.guard === 'fire') return input.newBad >= d.fireAfter;
  if (arm.guard === 'clear') return input.newGood >= d.clearAfter;
  return true;
}

/** Next alert state for one evaluation. Pure; same semantics as {@link alertStateKql}. */
export function nextAlertState(
  input: AlertStateInput,
  debounce: AlertDebounce = DEFAULT_ALERT_DEBOUNCE,
): AlertStateResult {
  const d = validDebounce(debounce);
  const prev = input.prevStatus || 'ok';
  const arm = ARMS.find((candidate) => armMatches(candidate, input, prev, d));
  return {
    status: arm?.next ?? 'ok',
    transitionedTo: arm === FIRE_ARM ? 'firing' : arm === CLEAR_ARM ? 'resolved' : '',
    fireCountDelta: arm === FIRE_ARM ? 1 : 0,
  };
}

// ── KQL emitters ─────────────────────────────────────────────────────

export interface AlertKqlFields {
  prevStatus?: string;
  isBad?: string;
  newBad?: string;
  newGood?: string;
  prevBad?: string;
  prevGood?: string;
  prevFireCount?: string;
}

export interface AlertKqlOptions extends Partial<AlertDebounce> {
  /** Column names; defaults are the snake_case names in {@link alertStateKql}. */
  fields?: AlertKqlFields;
  /**
   * {@link alertStateKql} only. `false` omits the leading
   * `prev_status=iff(isnotempty(prev_status), prev_status, "ok")` stage, for
   * a consumer that already defaults the prior status upstream (e.g. from a
   * `leftouter` join's null). The arms then require a non-empty prior
   * status: a null or `""` one matches no arm and reads `ok`, so a first
   * bad evaluation would not enter `pending`. Default `true`.
   */
  defaultPrevStatus?: boolean;
}

const FIELD_DEFAULTS: Required<AlertKqlFields> = {
  prevStatus: 'prev_status',
  isBad: 'is_bad',
  newBad: 'new_bad',
  newGood: 'new_good',
  prevBad: 'prev_bad',
  prevGood: 'prev_good',
  prevFireCount: 'prev_fire_count',
};

const KQL_COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function resolveOptions(opts: AlertKqlOptions): {
  f: Required<AlertKqlFields>;
  fire: string;
  clear: string;
} {
  const d = validDebounce({
    fireAfter: opts.fireAfter ?? DEFAULT_ALERT_DEBOUNCE.fireAfter,
    clearAfter: opts.clearAfter ?? DEFAULT_ALERT_DEBOUNCE.clearAfter,
  });
  const f = { ...FIELD_DEFAULTS, ...opts.fields };
  for (const [key, column] of Object.entries(f)) {
    if (!KQL_COLUMN.test(column)) throw new KqlSafetyError(`alert KQL field ${key} is not a plain column name`);
  }
  return { f, fire: kqlInteger(d.fireAfter), clear: kqlInteger(d.clearAfter) };
}

function armCondition(arm: Arm, f: Required<AlertKqlFields>, fire: string, clear: string): string {
  const parts = [arm.bad ? f.isBad : `not(${f.isBad})`, `${f.prevStatus} == "${arm.prev}"`];
  if (arm.guard === 'fire') parts.push(`${f.newBad} >= ${fire}`);
  if (arm.guard === 'clear') parts.push(`${f.newGood} >= ${clear}`);
  return parts.join(' and ');
}

/** One row of the arm table as KQL: the condition and where it leads. */
export interface AlertArmKql {
  /** e.g. `is_bad and prev_status == "pending" and new_bad >= 2`. */
  condition: string;
  next: AlertStatus;
  /** Non-empty on the single fire arm and the single resolve arm. */
  transition: AlertTransition;
}

export interface AlertArmConditions {
  /** Every arm in evaluation order; the first match wins, the default is `ok`. */
  arms: AlertArmKql[];
  /** The pending→firing condition — also the `fire_count` increment guard. */
  fire: string;
  /** The resolving→ok condition. */
  clear: string;
}

/**
 * The arm table rendered as KQL conditions, for a consumer composing its
 * own stages. These are the exact strings {@link alertCaseKql},
 * {@link alertTransitionKql} and {@link alertStateKql} embed.
 */
export function alertArmConditions(opts: AlertKqlOptions = {}): AlertArmConditions {
  const { f, fire, clear } = resolveOptions(opts);
  return {
    arms: ARMS.map((arm) => ({
      condition: armCondition(arm, f, fire, clear),
      next: arm.next,
      transition: arm === FIRE_ARM ? 'firing' : arm === CLEAR_ARM ? 'resolved' : '',
    })),
    fire: armCondition(FIRE_ARM, f, fire, clear),
    clear: armCondition(CLEAR_ARM, f, fire, clear),
  };
}

/**
 * The status `case()` expression: one arm per row of the shared table, in
 * order, defaulting to `"ok"`. Expects `prevStatus` already defaulted to
 * `"ok"` when there is no prior row — a null status matches no arm, so a
 * first bad evaluation would read `ok` instead of `pending`.
 * {@link alertStateKql} does that defaulting for you.
 */
export function alertCaseKql(opts: AlertKqlOptions = {}): string {
  const { f, fire, clear } = resolveOptions(opts);
  const arms = ARMS.map((arm) => `  ${armCondition(arm, f, fire, clear)}, "${arm.next}",`);
  return `case(\n${arms.join('\n')}\n  "ok")`;
}

/** `transitioned_to`: `"firing"`, `"resolved"` or `""` — the notification key. */
export function alertTransitionKql(opts: AlertKqlOptions = {}): string {
  const { f, fire, clear } = resolveOptions(opts);
  return `case(\n  ${armCondition(FIRE_ARM, f, fire, clear)}, "firing",\n  ${armCondition(CLEAR_ARM, f, fire, clear)}, "resolved",\n  "")`;
}

/**
 * The three pipeline stages of {@link alertStateKql}, separately, so a
 * consumer can splice its own stages between them and still emit
 * byte-identical steps. Each is one or more lines starting with `| extend`.
 */
export interface AlertStateStages {
  /** `| extend prev_status=iff(isnotempty(prev_status), prev_status, "ok")`. */
  defaultPrevStatus: string;
  /** `| extend new_bad=…, new_good=…` — the status arms read these. */
  counters: string;
  /** `| extend alert_status=…, consecutive_bad, consecutive_good, fire_count, transitioned_to`. */
  state: string;
}

/** Lower-level builder behind {@link alertStateKql}. Ignores `defaultPrevStatus`. */
export function alertStateStages(opts: AlertKqlOptions = {}): AlertStateStages {
  const { f, fire, clear } = resolveOptions(opts);
  const indent = (text: string) => text.split('\n').join('\n         ');
  return {
    defaultPrevStatus: `| extend ${f.prevStatus}=iff(isnotempty(${f.prevStatus}), ${f.prevStatus}, "ok")`,
    counters: [
      `| extend ${f.newBad}=iff(${f.isBad}, ${f.prevBad} + 1, 0),`,
      `         ${f.newGood}=iff(${f.isBad}, 0, ${f.prevGood} + 1)`,
    ].join('\n'),
    state: [
      `| extend alert_status=${indent(alertCaseKql(opts))},`,
      `         consecutive_bad=${f.newBad},`,
      `         consecutive_good=${f.newGood},`,
      `         fire_count=iff(${armCondition(FIRE_ARM, f, fire, clear)}, ${f.prevFireCount} + 1, ${f.prevFireCount}),`,
      `         transitioned_to=${indent(alertTransitionKql(opts))}`,
    ].join('\n'),
  };
}

/**
 * The whole state step as pipeline stages: default a missing prior status
 * to `"ok"`, counters next (the status arms read them), then status,
 * persisted counters, fire count and transition. Input columns:
 * `prev_status` (may be null/empty for a first evaluation), `is_bad`,
 * `prev_bad`, `prev_good`, `prev_fire_count`. Output columns:
 * `alert_status`, `consecutive_bad`, `consecutive_good`, `fire_count`,
 * `transitioned_to` (plus the intermediate `new_bad`/`new_good`).
 *
 * `defaultPrevStatus: false` drops the first stage for a consumer that
 * defaults the prior status itself; {@link alertStateStages} returns the
 * stages separately.
 */
export function alertStateKql(opts: AlertKqlOptions = {}): string {
  const stages = alertStateStages(opts);
  return [
    ...(opts.defaultPrevStatus === false ? [] : [stages.defaultPrevStatus]),
    stages.counters,
    stages.state,
  ].join('\n');
}
