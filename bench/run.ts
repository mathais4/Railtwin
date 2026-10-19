/**
 * Performance benchmark. Builds synthetic grid networks of increasing size,
 * fills them with random services, injects random incidents and times the
 * simulator. Results go to stdout and bench/results.md.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { Incident, Network, Scenario, Segment, Station, Train } from '../src/model/types.ts';
import { NetworkGraph } from '../src/graph/networkGraph.ts';
import { simulate } from '../src/sim/simulator.ts';
import { optimise } from '../src/sim/optimiser.ts';
import { DEFAULT_POLICY } from '../src/model/types.ts';
import { assignPlatforms } from '../src/timetable/builder.ts';
import { builtInScenarios, CONTROL_POLICY } from '../src/data/scenarios.ts';
import { mulberry32 } from '../src/util/rng.ts';

function gridNetwork(rows: number, cols: number, platforms: number): Network {
  const stations: Station[] = [];
  const segments: Segment[] = [];
  const id = (r: number, c: number) => `S${r}_${c}`;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) stations.push({ id: id(r, c), name: id(r, c), platforms, x: c * 10, y: r * 10 });
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) segments.push({ id: `${id(r, c)}-${id(r, c + 1)}`, from: id(r, c), to: id(r, c + 1), runTime: 6 + ((r + c) % 4), tracks: 2, headway: 3 });
      if (r + 1 < rows) segments.push({ id: `${id(r, c)}-${id(r + 1, c)}`, from: id(r, c), to: id(r + 1, c), runTime: 7 + ((r * c) % 3), tracks: (r + c) % 3 === 0 ? 1 : 2, headway: 3 });
    }
  return { id: `grid-${rows}x${cols}`, name: 'grid', stations, segments };
}

function randomTrains(net: Network, count: number, seed: number): Train[] {
  const rng = mulberry32(seed);
  const g = new NetworkGraph(net);
  const trains: Train[] = [];
  const ids = net.stations.map((s) => s.id);
  while (trains.length < count) {
    const a = ids[Math.floor(rng() * ids.length)];
    const b = ids[Math.floor(rng() * ids.length)];
    const path = g.shortestPath(a, b);
    if (!path || path.steps.length < 3) continue;
    // Calling points: origin, every other station, destination.
    const calls = [a, ...path.steps.filter((_, i) => i % 2 === 1).map((s) => s.to)];
    if (calls[calls.length - 1] !== b) calls.push(b);
    let t = 300 + rng() * 1080;
    const stops: Train['stops'] = [{ station: calls[0], dep: Math.round(t) }];
    t = Math.round(t);
    for (let i = 1; i < calls.length; i++) {
      const leg = g.shortestPath(calls[i - 1], calls[i])!;
      t += Math.ceil(leg.time * 1.08 + 1);
      const last = i === calls.length - 1;
      stops.push(last ? { station: calls[i], arr: t } : { station: calls[i], arr: t, dep: t + 1 });
      if (!last) t += 1;
    }
    trains.push({ id: `T${trains.length}`, name: `T${trains.length}`, kind: 'local', priority: Math.floor(rng() * 3), passengers: 50 + Math.floor(rng() * 300), stops });
  }
  return trains;
}

function randomIncidents(net: Network, trains: Train[], n: number, seed: number): Incident[] {
  const rng = mulberry32(seed);
  const inc: Incident[] = [];
  for (let i = 0; i < n; i++) {
    const from = 400 + rng() * 600;
    if (rng() < 0.5) {
      const t = trains[Math.floor(rng() * trains.length)];
      inc.push({ kind: 'trainDelay', train: t.id, stopIndex: 0, minutes: 5 + rng() * 20 });
    } else {
      inc.push({ kind: 'speedRestriction', segment: net.segments[Math.floor(rng() * net.segments.length)].id, extra: 3 + rng() * 8, from, to: from + 60 });
    }
  }
  return inc;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const rows: string[] = [];
const log = (s: string) => {
  console.log(s);
  rows.push(s);
};

log(`# RailTwin benchmark\n`);
log(`Node ${process.version} on ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${new Date().toISOString().slice(0, 10)}. Median of 5 runs after one warm-up.\n`);
log(`| Network | Trains | Incidents | Events | Median ms | Events / s | Trains / s | Gridlocked |`);
log(`|---|---:|---:|---:|---:|---:|---:|:---:|`);

for (const [r, c, n, p] of [
  [6, 6, 250, 6],
  [10, 10, 1000, 8],
  [14, 14, 4000, 16],
  [20, 20, 8000, 20],
] as const) {
  const net = gridNetwork(r, c, p);
  const trains = randomTrains(net, n, r * 1000 + c);
  try {
    assignPlatforms(net, trains, 0.5);
  } catch {
    // Dense random timetables can overfill a station; the simulator will then queue for platforms.
  }
  const sc: Scenario = { id: 'bench', name: 'bench', description: '', network: net, timetable: { trains, connections: [] }, incidents: randomIncidents(net, trains, Math.ceil(n / 50), 99) };
  simulate(sc, CONTROL_POLICY, { lean: true });
  const times: number[] = [];
  let events = 0;
  let deadlocked = false;
  for (let i = 0; i < 5; i++) {
    const res = simulate(sc, CONTROL_POLICY, { lean: true });
    times.push(res.runtimeMs);
    events = res.kpis.events;
    deadlocked = res.kpis.deadlocked;
  }
  const ms = median(times);
  log(`| ${r}×${c} grid, ${net.segments.length} segments | ${n} | ${sc.incidents.length} | ${events.toLocaleString('en')} | ${ms.toFixed(1)} | ${Math.round(events / (ms / 1000)).toLocaleString('en')} | ${Math.round(n / (ms / 1000)).toLocaleString('en')} | ${deadlocked ? 'yes' : 'no'} |`);
}

log(`\n## Sample network (47 trains)\n`);
log(`| Scenario | Full sim, ms | Optimiser: simulations | Optimiser ms | Passenger-min, no action → optimised |`);
log(`|---|---:|---:|---:|---|`);
for (const sc of builtInScenarios) {
  simulate(sc);
  const sim = median([0, 1, 2, 3, 4].map(() => simulate(sc).runtimeMs));
  const o = optimise(sc, DEFAULT_POLICY);
  log(`| ${sc.name} | ${sim.toFixed(2)} | ${o.evaluations} | ${o.elapsedMs.toFixed(0)} | ${o.startCost.toLocaleString('en')} → ${o.bestCost.toLocaleString('en')} |`);
}

writeFileSync(fileURLToPath(new URL('./results.md', import.meta.url)), rows.join('\n') + '\n');
