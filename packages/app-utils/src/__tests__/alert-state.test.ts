import { describe, expect, it } from 'vitest';
import {
  ALERT_STATUSES,
  DEFAULT_ALERT_DEBOUNCE,
  alertCaseKql,
  alertStateKql,
  alertTransitionKql,
  nextAlertCounters,
  nextAlertState,
  type AlertDebounce,
  type AlertStatus,
} from '../alert-state.js';
import { KqlSafetyError } from '../kql.js';
import { evalKqlExpr, runExtendStages } from './helpers/mini-kql.js';

type Case = [prev: string | null, isBad: boolean, newBad: number, newGood: number, status: AlertStatus, transition: string, delta: 0 | 1];

// Every arm of the production evaluator, with the default debounce (2/3).
const TRANSITIONS: Case[] = [
  ['ok', true, 1, 0, 'pending', '', 0],
  ['pending', true, 1, 0, 'pending', '', 0],
  ['pending', true, 2, 0, 'firing', 'firing', 1],
  ['pending', true, 5, 0, 'firing', 'firing', 1],
  ['firing', true, 3, 0, 'firing', '', 0],
  // Relapse during clear-out: back to firing, NOT a new fire.
  ['resolving', true, 1, 0, 'firing', '', 0],
  ['ok', false, 0, 1, 'ok', '', 0],
  // A flap that never fired goes straight back to ok, with no `resolved`.
  ['pending', false, 0, 1, 'ok', '', 0],
  ['firing', false, 0, 1, 'resolving', '', 0],
  ['resolving', false, 0, 2, 'resolving', '', 0],
  ['resolving', false, 0, 3, 'ok', 'resolved', 0],
  ['resolving', false, 0, 9, 'ok', 'resolved', 0],
  // The KQL default arm: an unrecognised persisted status reads ok either way.
  ['garbage', true, 1, 0, 'ok', '', 0],
  ['garbage', false, 0, 1, 'ok', '', 0],
];

describe('nextAlertState', () => {
  it.each(TRANSITIONS)('%s + bad=%s (bad=%i good=%i) → %s %s', (prev, isBad, newBad, newGood, status, transition, delta) => {
    expect(nextAlertState({ prevStatus: prev, isBad, newBad, newGood })).toEqual({
      status,
      transitionedTo: transition,
      fireCountDelta: delta,
    });
  });

  it('treats a missing prior status as ok (first evaluation enters pending)', () => {
    for (const prevStatus of [null, undefined, '']) {
      expect(nextAlertState({ prevStatus, isBad: true, newBad: 1, newGood: 0 }).status).toBe('pending');
    }
  });

  it('honours custom thresholds', () => {
    const d = { fireAfter: 4, clearAfter: 1 };
    expect(nextAlertState({ prevStatus: 'pending', isBad: true, newBad: 3, newGood: 0 }, d).status).toBe('pending');
    expect(nextAlertState({ prevStatus: 'pending', isBad: true, newBad: 4, newGood: 0 }, d).status).toBe('firing');
    expect(nextAlertState({ prevStatus: 'resolving', isBad: false, newBad: 0, newGood: 1 }, d).status).toBe('ok');
  });

  it('never fires straight from ok, even with fireAfter=1 (the evaluator does not)', () => {
    expect(nextAlertState({ prevStatus: 'ok', isBad: true, newBad: 1, newGood: 0 }, { fireAfter: 1, clearAfter: 1 }).status).toBe('pending');
  });

  it('rejects nonsensical thresholds', () => {
    expect(() => nextAlertState({ prevStatus: 'ok', isBad: true, newBad: 1, newGood: 0 }, { fireAfter: 0, clearAfter: 3 })).toThrow(RangeError);
    expect(() => alertCaseKql({ clearAfter: 1.5 })).toThrow(RangeError);
  });

  it('walks a full incident with counters computed as the evaluator does', () => {
    const evals = [false, true, true, true, false, true, false, false, false, false];
    let status: AlertStatus = 'ok';
    let bad = 0; let good = 0; let fires = 0;
    const seen: string[] = [];
    for (const isBad of evals) {
      const { newBad, newGood } = nextAlertCounters(isBad, bad, good);
      const r = nextAlertState({ prevStatus: status, isBad, newBad, newGood });
      status = r.status; bad = newBad; good = newGood; fires += r.fireCountDelta;
      seen.push(r.transitionedTo ? `${status}!` : status);
    }
    expect(seen).toEqual(['ok', 'pending', 'firing!', 'firing', 'resolving', 'firing', 'resolving', 'resolving', 'ok!', 'ok']);
    expect(fires).toBe(1);
  });
});

describe('emitted KQL has the same semantics as nextAlertState', () => {
  const debounces: AlertDebounce[] = [DEFAULT_ALERT_DEBOUNCE, { fireAfter: 1, clearAfter: 1 }, { fireAfter: 3, clearAfter: 5 }];
  const prevs = [...ALERT_STATUSES, 'garbage'];

  it.each(debounces)('every (prev, isBad, newBad, newGood) agrees for %o', (debounce) => {
    const status = alertCaseKql(debounce);
    const transition = alertTransitionKql(debounce);
    let checked = 0;
    for (const prevStatus of prevs) {
      for (const isBad of [true, false]) {
        for (let n = 0; n <= 6; n += 1) {
          const newBad = isBad ? n : 0;
          const newGood = isBad ? 0 : n;
          const row = { prev_status: prevStatus, is_bad: isBad, new_bad: newBad, new_good: newGood };
          const ts = nextAlertState({ prevStatus, isBad, newBad, newGood }, debounce);
          expect(evalKqlExpr(status, row), JSON.stringify(row)).toBe(ts.status);
          expect(evalKqlExpr(transition, row), JSON.stringify(row)).toBe(ts.transitionedTo);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(prevs.length * 2 * 7);
  });

  it('the full state step matches a TS replay, including counters, fire count and a null first status', () => {
    const kql = alertStateKql();
    const evals = [true, true, false, true, false, false, false, true, true];
    let row: Record<string, string | number | boolean | null> = {
      prev_status: null, prev_bad: 0, prev_good: 0, prev_fire_count: 0,
    };
    let ts = { status: 'ok' as AlertStatus, bad: 0, good: 0, fires: 0 };
    for (const isBad of evals) {
      const out = runExtendStages(kql, { ...row, is_bad: isBad });
      const { newBad, newGood } = nextAlertCounters(isBad, ts.bad, ts.good);
      const r = nextAlertState({ prevStatus: ts.status, isBad, newBad, newGood });
      ts = { status: r.status, bad: newBad, good: newGood, fires: ts.fires + r.fireCountDelta };
      expect(out).toMatchObject({
        alert_status: ts.status,
        consecutive_bad: ts.bad,
        consecutive_good: ts.good,
        fire_count: ts.fires,
        transitioned_to: r.transitionedTo,
      });
      row = {
        prev_status: out.alert_status, prev_bad: out.consecutive_bad,
        prev_good: out.consecutive_good, prev_fire_count: out.fire_count,
      };
    }
    expect(ts.fires).toBe(2);
  });

  it('renames columns and rejects anything that is not a plain column', () => {
    const kql = alertCaseKql({ fields: { prevStatus: 'persisted_status', isBad: 'bad' } });
    expect(kql).toContain('bad and persisted_status == "ok", "pending"');
    expect(() => alertCaseKql({ fields: { isBad: 'x) or (true' } })).toThrow(KqlSafetyError);
  });

  it('emits the evaluator arms verbatim (snapshot)', () => {
    expect(alertStateKql()).toMatchInlineSnapshot(`
      "| extend prev_status=iff(isnotempty(prev_status), prev_status, "ok")
      | extend new_bad=iff(is_bad, prev_bad + 1, 0),
               new_good=iff(is_bad, 0, prev_good + 1)
      | extend alert_status=case(
                 is_bad and prev_status == "ok", "pending",
                 is_bad and prev_status == "pending" and new_bad >= 2, "firing",
                 is_bad and prev_status == "pending", "pending",
                 is_bad and prev_status == "firing", "firing",
                 is_bad and prev_status == "resolving", "firing",
                 not(is_bad) and prev_status == "pending", "ok",
                 not(is_bad) and prev_status == "firing", "resolving",
                 not(is_bad) and prev_status == "resolving" and new_good >= 3, "ok",
                 not(is_bad) and prev_status == "resolving", "resolving",
                 "ok"),
               consecutive_bad=new_bad,
               consecutive_good=new_good,
               fire_count=iff(is_bad and prev_status == "pending" and new_bad >= 2, prev_fire_count + 1, prev_fire_count),
               transitioned_to=case(
                 is_bad and prev_status == "pending" and new_bad >= 2, "firing",
                 not(is_bad) and prev_status == "resolving" and new_good >= 3, "resolved",
                 "")"
    `);
  });
});
