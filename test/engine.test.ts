import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MinHeap } from '../src/util/heap.ts';
import { mulberry32 } from '../src/util/rng.ts';
import { NetworkGraph } from '../src/graph/networkGraph.ts';
import { simulate } from '../src/sim/simulator.ts';
import { DEFAULT_POLICY } from '../src/model/types.ts';
import { sampleNetwork, buildSampleTimetable, samplePatterns } from '../src/data/sampleNetwork.ts';
import { assignPlatforms, buildTrains } from '../src/timetable/builder.ts';
import { line, train } from './helpers.ts';

test('MinHeap pops in order, including duplicates', () => {
  const rng = mulberry32(7);
  const h = new MinHeap<number>((a, b) => a < b);
  const xs = Array.from({ length: 2000 }, () => Math.floor(rng() * 500));
  xs.forEach((x) => h.push(x));
  const out: number[] = [];
  while (h.size) out.push(h.pop()!);
  assert.deepEqual(out, [...xs].sort((a, b) => a - b));
});

test('Dijkstra finds the fastest path and honours avoided segments', () => {
  const g = new NetworkGraph(sampleNetwork);
  const p = g.shortestPath('ASH', 'RVC')!;
  assert.deepEqual(p.steps.map((s) => s.seg.id), ['ASH-MIL', 'MIL-RVC']);
  assert.equal(p.time, 20);
  const alt = g.shortestPath('ASH', 'RVC', new Set(['MIL-RVC']))!;
  assert.deepEqual(alt.steps.map((s) => s.seg.id), ['ASH-RVC']);
  assert.equal(g.shortestPath('LGA', 'WHV', new Set(['ASH-COR'])), null);
});

test('platform assignment never double-books a platform', () => {
  const trains = buildTrains(sampleNetwork, samplePatterns);
  assignPlatforms(sampleNetwork, trains);
  const byPlatform = new Map<string, [number, number][]>();
  for (const t of trains) {
    t.stops.forEach((s, i) => {
      const start = i === 0 ? s.dep! - 5 : s.arr!;
      const end = i === t.stops.length - 1 ? s.arr! + 4 : s.dep!;
      const k = `${s.station}:${s.platform}`;
      byPlatform.set(k, [...(byPlatform.get(k) ?? []), [start, end]]);
    });
  }
  for (const [k, iv] of byPlatform) {
    iv.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < iv.length; i++) assert.ok(iv[i][0] >= iv[i - 1][1], `overlap on ${k}`);
  }
});

test('the undisrupted sample timetable runs perfectly', () => {
  const sc = { id: 'b', name: 'b', description: '', network: sampleNetwork, timetable: buildSampleTimetable(), incidents: [] };
  const r = simulate(sc);
  assert.equal(r.kpis.punctualityPct, 100);
  assert.equal(r.kpis.connectionsMissed, 0);
  assert.equal(r.kpis.deadlocked, false);
  for (const t of r.trains) assert.ok(t.finalDelay! <= 0.01, `${t.id} late in baseline`);
});

test('a late train delays the train behind it on the same track (headway)', () => {
  const sc = line({
    bcTracks: 2,
    trains: [
      train('T1', [{ station: 'A', dep: 600, platform: 1 }, { station: 'C', arr: 622, platform: 1 }]),
      train('T2', [{ station: 'A', dep: 604, platform: 2 }, { station: 'C', arr: 626, platform: 2 }]),
    ],
  });
  sc.incidents = [{ kind: 'trainDelay', train: 'T1', stopIndex: 0, minutes: 3 }];
  const r = simulate(sc);
  const [t1, t2] = r.trains;
  assert.equal(t1.stops[0].dep, 603);
  assert.equal(t2.stops[0].dep, 606, 'T2 must keep 3 minutes behind T1');
  assert.equal(t2.directlyAffected, false);
  assert.ok(r.knockOn.some((e) => e.from === 'T1' && e.to === 'T2'));
});

test('single track: opposing trains wait for each other', () => {
  const sc = line({
    trains: [
      train('UP', [{ station: 'C', dep: 600, platform: 1 }, { station: 'B', arr: 611, platform: 1 }]),
      train('DN', [{ station: 'B', dep: 605, platform: 2 }, { station: 'C', arr: 616, platform: 2 }]),
    ],
  });
  const r = simulate(sc);
  const dn = r.trains.find((t) => t.id === 'DN')!;
  assert.equal(dn.stops[0].dep, 610, 'DN can only enter once UP has cleared the single line');
  assert.equal(dn.waitByKind.singleTrack, 5);
});

test('holding a connection trades outbound delay for a made connection', () => {
  const trains = [
    train('FEED', [{ station: 'A', dep: 600, platform: 1 }, { station: 'B', arr: 611, platform: 1 }]),
    train('OUT', [{ station: 'B', dep: 615, platform: 2 }, { station: 'C', arr: 626, platform: 2 }]),
  ];
  const connections = [{ id: 'c', station: 'B', fromTrain: 'FEED', toTrain: 'OUT', minTransfer: 3, maxHold: 6, passengers: 80 }];
  const sc = line({ trains, connections });
  sc.incidents = [{ kind: 'trainDelay', train: 'FEED', stopIndex: 0, minutes: 4 }];

  const noHold = simulate(sc);
  assert.equal(noHold.connections[0].made, false);
  assert.equal(noHold.trains[1].stops[0].dep, 615);

  const hold = simulate(sc, { ...DEFAULT_POLICY, holdConnections: true });
  assert.equal(hold.connections[0].made, true);
  assert.equal(hold.trains[1].stops[0].dep, 617, 'feeder arrives 614, plus 3 minutes to change');

  // A feeder too late to make it within maxHold is not waited for at all.
  sc.incidents = [{ kind: 'trainDelay', train: 'FEED', stopIndex: 0, minutes: 30 }];
  const hopeless = simulate(sc, { ...DEFAULT_POLICY, holdConnections: true });
  assert.equal(hopeless.trains[1].stops[0].dep, 615);
});

test('platform changes route around a closed platform', () => {
  const sc = line({ trains: [train('T', [{ station: 'A', dep: 600, platform: 1 }, { station: 'B', arr: 611, platform: 1 }])] });
  sc.incidents = [{ kind: 'platformClosure', station: 'B', platforms: [1], from: 0, to: 700 }];
  const rigid = simulate(sc);
  assert.equal(rigid.trains[0].stops[1].arr, 700);
  const flexible = simulate(sc, { ...DEFAULT_POLICY, allowPlatformChange: true });
  assert.equal(flexible.trains[0].stops[1].arr, 610);
  assert.equal(flexible.trains[0].stops[1].platform, 2);
  assert.equal(flexible.kpis.platformChanges, 1);
});

test('priority dispatch makes a slow train yield to an approaching fast one', () => {
  const trains = [
    train('SLOW', [{ station: 'B', dep: 602, platform: 1 }, { station: 'C', arr: 630, platform: 1 }], { runTimeFactor: 2, priority: 0 }),
    train('FAST', [{ station: 'A', dep: 594, platform: 1 }, { station: 'C', arr: 619, platform: 2 }], { priority: 3 }),
  ];
  const sc = line({ bcTracks: 2, trains });
  const fifo = simulate(sc);
  const prio = simulate(sc, { ...DEFAULT_POLICY, dispatch: 'priority' });
  const fast = (r: typeof fifo) => r.trains.find((t) => t.id === 'FAST')!.finalDelay!;
  assert.ok(fast(prio) < fast(fifo), `FAST should gain: fifo ${fast(fifo)}, priority ${fast(prio)}`);
});

test('reroute intervention takes the diversion', () => {
  const sc = { id: 'r', name: 'r', description: '', network: sampleNetwork, timetable: buildSampleTimetable(), incidents: [] };
  const r = simulate(sc, { ...DEFAULT_POLICY, interventions: [{ kind: 'reroute', train: 'IC-D-0700', avoid: ['MIL-RVC'] }] });
  const segs = r.movements.filter((m) => m.train === 'IC-D-0700').map((m) => m.segment);
  assert.ok(segs.includes('ASH-RVC') && !segs.includes('MIL-RVC'));
});

test('a train is kept off a single line until it has a platform at the far end', () => {
  // B has one platform. Y starts there and wants the single line that X is already coming down.
  const sc = line({
    platformsB: 1,
    trains: [
      train('X', [{ station: 'C', dep: 600, platform: 1 }, { station: 'B', arr: 611, platform: 1 }]),
      train('Y', [{ station: 'B', dep: 612, platform: 1 }, { station: 'C', arr: 623, platform: 2 }]),
    ],
  });
  const r = simulate(sc);
  assert.equal(r.kpis.deadlocked, false, 'without the berth rule X and Y would lock each other out');
  assert.ok(r.trains.every((t) => t.completed));
});

test('trains that can never finish are reported, with what they are waiting for', () => {
  const sc = line({ platformsB: 1, trains: [train('X', [{ station: 'C', dep: 600, platform: 1 }, { station: 'B', arr: 611, platform: 1 }])] });
  sc.incidents = [{ kind: 'platformClosure', station: 'B', platforms: [1], from: 605, to: 5000 }];
  const r = simulate(sc, DEFAULT_POLICY, { maxTime: 900 });
  assert.equal(r.kpis.deadlocked, true);
  assert.deepEqual(r.deadlock?.stuck, ['X']);
  assert.equal(r.trains[0].completed, false);
});

test('unknown intervention targets are rejected', () => {
  const sc = line({ trains: [train('T', [{ station: 'A', dep: 600 }, { station: 'B', arr: 611 }])] });
  assert.throws(() => simulate(sc, { ...DEFAULT_POLICY, interventions: [{ kind: 'prioritise', train: 'NOPE' }] }), /unknown train/);
});

test('simulation is deterministic', () => {
  const sc = { id: 'd', name: 'd', description: '', network: sampleNetwork, timetable: buildSampleTimetable(), incidents: [] };
  const a = simulate(sc, DEFAULT_POLICY, { noise: { seed: 42, runTimeMean: 0.5, dwellMean: 0.5 } });
  const b = simulate(sc, DEFAULT_POLICY, { noise: { seed: 42, runTimeMean: 0.5, dwellMean: 0.5 } });
  assert.deepEqual(a.trains, b.trains);
  assert.deepEqual(a.knockOn, b.knockOn);
});
