/**
 * Synthesises "observed" days for the built-in scenarios.
 *
 * No real operational data ships with this repo, so ground truth is produced by
 * running the simulator with (a) the incidents as they actually happened, which
 * differ from what was reported, and (b) seeded random running-time and dwell
 * overruns. The prediction model only ever sees the reported incidents, so the
 * replay score measures how well it copes with imperfect information.
 *
 * To score against real data instead, import observed times with
 * `npm run cli -- import-observed <scenario> <file.csv>` (see README).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildScenario, CONTROL_POLICY, OBSERVED_NOISE, scenarioSpecs } from '../src/data/scenarios.ts';
import { simulate } from '../src/sim/simulator.ts';
import type { ObservedStopTime } from '../src/model/types.ts';

const out: Record<string, ObservedStopTime[]> = {};
scenarioSpecs.forEach((spec, i) => {
  const truth = { ...buildScenario(spec), incidents: spec.actual };
  const r = simulate(truth, CONTROL_POLICY, {
    noise: { seed: 1000 + i * 7919, ...OBSERVED_NOISE },
    lean: true,
  });
  const rows: ObservedStopTime[] = [];
  for (const t of r.trains) {
    t.stops.forEach((s, seq) => {
      const row: ObservedStopTime = { train: t.id, seq };
      // Real systems report to the nearest half-minute or so.
      if (s.arr !== null) row.arr = Math.round(s.arr * 2) / 2;
      if (s.dep !== null) row.dep = Math.round(s.dep * 2) / 2;
      if (row.arr !== undefined || row.dep !== undefined) rows.push(row);
    });
  }
  out[spec.id] = rows;
  console.log(`${spec.id}: ${rows.length} observed stop times, punctuality ${r.kpis.punctualityPct}%`);
});

const path = fileURLToPath(new URL('../src/data/observed.json', import.meta.url));
writeFileSync(path, JSON.stringify(out) + '\n');
console.log(`wrote ${path}`);
