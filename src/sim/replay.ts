import type { Policy, Scenario, SimOptions } from '../model/types.ts';
import { DEFAULT_POLICY } from '../model/types.ts';
import { simulate } from './simulator.ts';
import { round } from './metrics.ts';

export interface ErrorStats {
  n: number;
  /** Mean absolute error, minutes. */
  mae: number;
  /** Root mean squared error, minutes. */
  rmse: number;
  /** Mean signed error (predicted − observed); negative means the model is optimistic. */
  bias: number;
  /** Share of predictions within 2 minutes of what happened. */
  within2Pct: number;
}

export function errorStats(errors: number[]): ErrorStats {
  const n = errors.length;
  if (n === 0) return { n: 0, mae: 0, rmse: 0, bias: 0, within2Pct: 0 };
  let abs = 0;
  let sq = 0;
  let sum = 0;
  let within = 0;
  for (const e of errors) {
    abs += Math.abs(e);
    sq += e * e;
    sum += e;
    if (Math.abs(e) <= 2) within++;
  }
  return {
    n,
    mae: round(abs / n, 2),
    rmse: round(Math.sqrt(sq / n), 2),
    bias: round(sum / n, 2),
    within2Pct: round((100 * within) / n, 1),
  };
}

export interface ReplayPoint {
  train: string;
  seq: number;
  station: string;
  event: 'arr' | 'dep';
  scheduled: number;
  observed: number;
  predicted: number | null;
  persistence: number;
}

export interface MethodScores {
  /** RailTwin's simulation, given only the reported incidents. */
  model: ErrorStats;
  /** "Everything runs to the timetable." */
  timetable: ErrorStats;
  /** "A late train stays exactly as late; nothing else is affected." */
  persistence: ErrorStats;
}

/** Observed delay (minutes) at which a point counts as disrupted. */
export const DISRUPTED_THRESHOLD = 3;

export interface ReplayReport extends MethodScores {
  scenarioId: string;
  points: ReplayPoint[];
  missingPredictions: number;
  /** The same scores restricted to points that were actually running late — where prediction matters. */
  disrupted: MethodScores;
  perTrain: { id: string; name: string; mae: number; maxAbsError: number }[];
}

/**
 * Replays a historical scenario: simulates it from the reported incidents only,
 * then scores every predicted arrival/departure against what was observed, next to
 * two naive baselines. Beating the baselines is the minimum bar for the model to be useful.
 */
export function replay(scenario: Scenario, policy: Policy = DEFAULT_POLICY, options: SimOptions = {}): ReplayReport {
  const observed = scenario.observed ?? [];
  const result = simulate(scenario, policy, { ...options, lean: true });
  const byId = new Map(result.trains.map((t) => [t.id, t]));
  const trainDefs = new Map(scenario.timetable.trains.map((t) => [t.id, t]));

  const lateStarts = new Map<string, { stopIndex: number; minutes: number }[]>();
  for (const inc of scenario.incidents) {
    if (inc.kind !== 'trainDelay') continue;
    const list = lateStarts.get(inc.train) ?? [];
    list.push({ stopIndex: inc.stopIndex, minutes: inc.minutes });
    lateStarts.set(inc.train, list);
  }
  const persistedDelay = (train: string, seq: number, event: 'arr' | 'dep') =>
    (lateStarts.get(train) ?? [])
      .filter((d) => (event === 'arr' ? d.stopIndex < seq : d.stopIndex <= seq))
      .reduce((s, d) => s + d.minutes, 0);

  const points: ReplayPoint[] = [];
  let missing = 0;
  for (const o of observed) {
    const def = trainDefs.get(o.train);
    const sim = byId.get(o.train);
    if (!def || !sim) continue;
    const stop = def.stops[o.seq];
    const simStop = sim.stops[o.seq];
    if (!stop || !simStop) continue;
    const add = (event: 'arr' | 'dep', obs: number | undefined, sched: number | undefined, pred: number | null) => {
      if (obs === undefined || sched === undefined) return;
      if (pred === null) missing++;
      points.push({
        train: o.train,
        seq: o.seq,
        station: stop.station,
        event,
        scheduled: sched,
        observed: obs,
        predicted: pred,
        persistence: sched + persistedDelay(o.train, o.seq, event),
      });
    };
    if (o.seq > 0) add('arr', o.arr, stop.arr, simStop.arr);
    else add('dep', o.dep, stop.dep, simStop.dep);
  }

  const scored = points.filter((p) => p.predicted !== null);
  const perTrainMap = new Map<string, number[]>();
  for (const p of scored) {
    const list = perTrainMap.get(p.train) ?? [];
    list.push(p.predicted! - p.observed);
    perTrainMap.set(p.train, list);
  }

  const scores = (ps: ReplayPoint[]): MethodScores => ({
    model: errorStats(ps.map((p) => p.predicted! - p.observed)),
    timetable: errorStats(ps.map((p) => p.scheduled - p.observed)),
    persistence: errorStats(ps.map((p) => p.persistence - p.observed)),
  });

  return {
    scenarioId: scenario.id,
    points,
    missingPredictions: missing,
    ...scores(scored),
    disrupted: scores(scored.filter((p) => p.observed - p.scheduled >= DISRUPTED_THRESHOLD)),
    perTrain: [...perTrainMap.entries()]
      .map(([id, errs]) => ({
        id,
        name: trainDefs.get(id)!.name,
        mae: errorStats(errs).mae,
        maxAbsError: round(Math.max(...errs.map(Math.abs)), 2),
      }))
      .sort((a, b) => b.mae - a.mae),
  };
}

export interface CalibrationResult {
  runTimeScale: number;
  extraDwell: number;
  trainMae: number;
  evaluated: number;
}

/**
 * Grid search for the global running-time scale and extra dwell that best fit a
 * set of observed scenarios. Fit on some days, test on others, to check the
 * calibration generalises rather than memorising.
 */
export function calibrate(
  scenarios: Scenario[],
  policy: Policy = DEFAULT_POLICY,
  grid = {
    runTimeScale: [0.98, 1, 1.02, 1.04, 1.06, 1.08],
    extraDwell: [0, 0.2, 0.4, 0.6, 0.8],
  },
): CalibrationResult {
  let best: CalibrationResult = { runTimeScale: 1, extraDwell: 0, trainMae: Infinity, evaluated: 0 };
  let evaluated = 0;
  for (const runTimeScale of grid.runTimeScale) {
    for (const extraDwell of grid.extraDwell) {
      let abs = 0;
      let n = 0;
      for (const sc of scenarios) {
        const r = replay(sc, policy, { runTimeScale, extraDwell });
        abs += r.model.mae * r.model.n;
        n += r.model.n;
      }
      evaluated++;
      const mae = n ? abs / n : Infinity;
      if (mae < best.trainMae) best = { runTimeScale, extraDwell, trainMae: round(mae, 3), evaluated: 0 };
    }
  }
  return { ...best, evaluated };
}
