import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtInScenarios, CONTROL_POLICY, getBuiltInScenario } from '../src/data/scenarios.ts';
import { simulate } from '../src/sim/simulator.ts';
import { compareResponses, cost } from '../src/sim/strategies.ts';
import { optimise } from '../src/sim/optimiser.ts';
import { calibrate, errorStats, replay } from '../src/sim/replay.ts';
import { DEFAULT_POLICY, type Incident } from '../src/model/types.ts';
import { mulberry32 } from '../src/util/rng.ts';

test('every built-in scenario has observed data and is disrupted', () => {
  for (const sc of builtInScenarios) {
    assert.ok(sc.observed && sc.observed.length > 100, `${sc.id} observed`);
    assert.ok(simulate(sc).kpis.passengerDelayMinutes > 0, `${sc.id} should cost something`);
  }
});

test('the optimiser never does worse than its starting policy, and beats every preset somewhere', () => {
  let beatAllPresets = 0;
  for (const sc of builtInScenarios) {
    const o = optimise(sc, DEFAULT_POLICY, { maxEvaluations: 200 });
    assert.ok(o.bestCost <= o.startCost, sc.id);
    assert.equal(cost(o.result), o.bestCost, 'reported cost matches the returned run');
    const c = compareResponses(sc);
    if (c.runs.every((r) => o.bestCost < cost(r.result))) beatAllPresets++;
  }
  assert.ok(beatAllPresets >= 1);
});

test('signal failure: rerouting intercity trains over the cut-off is found and helps', () => {
  const sc = getBuiltInScenario('signal-failure')!;
  const o = optimise(sc);
  assert.ok(o.steps.some((s) => s.label.startsWith('Reroute IC-')));
});

test('platform closure: flexible platforms recover most of the delay', () => {
  const c = compareResponses(getBuiltInScenario('platform-closure')!);
  const rigid = c.runs.find((r) => r.id === 'timetable')!.result.kpis.passengerDelayMinutes;
  const flex = c.runs.find((r) => r.id === 'platforms')!.result.kpis.passengerDelayMinutes;
  assert.ok(flex < rigid * 0.05, `${flex} vs ${rigid}`);
});

test('replay: the model beats both naive baselines on every scenario', () => {
  for (const sc of builtInScenarios) {
    const r = replay(sc, CONTROL_POLICY);
    assert.equal(r.missingPredictions, 0);
    assert.ok(r.model.mae < r.timetable.mae, `${sc.id}: model ${r.model.mae} vs timetable ${r.timetable.mae}`);
    assert.ok(r.model.mae < r.persistence.mae, `${sc.id}: model ${r.model.mae} vs persistence ${r.persistence.mae}`);
  }
});

test('calibration fitted on some days improves held-out days', () => {
  const cal = calibrate(builtInScenarios.slice(0, 3), CONTROL_POLICY);
  for (const sc of builtInScenarios.slice(3)) {
    const before = replay(sc, CONTROL_POLICY).model.mae;
    const after = replay(sc, CONTROL_POLICY, { runTimeScale: cal.runTimeScale, extraDwell: cal.extraDwell }).model.mae;
    assert.ok(after <= before, `${sc.id}: ${before} → ${after}`);
  }
});

test('errorStats arithmetic', () => {
  const s = errorStats([1, -1, 3, -3]);
  assert.equal(s.mae, 2);
  assert.equal(s.bias, 0);
  assert.equal(s.rmse, Math.round(Math.sqrt(5) * 100) / 100);
  assert.equal(s.within2Pct, 50);
});

test('random incidents never crash the engine and every train is accounted for', () => {
  const base = builtInScenarios[0];
  const rng = mulberry32(2026);
  const segs = base.network.segments.map((s) => s.id);
  const trains = base.timetable.trains;
  const policies = [DEFAULT_POLICY, CONTROL_POLICY, { ...DEFAULT_POLICY, dispatch: 'priority' as const, allowPlatformChange: true }];
  for (let i = 0; i < 60; i++) {
    const incidents: Incident[] = [];
    const n = 1 + Math.floor(rng() * 4);
    for (let k = 0; k < n; k++) {
      const from = 380 + rng() * 150;
      const pick = rng();
      if (pick < 0.35) {
        const t = trains[Math.floor(rng() * trains.length)];
        incidents.push({ kind: 'trainDelay', train: t.id, stopIndex: Math.floor(rng() * (t.stops.length - 1)), minutes: 1 + rng() * 25 });
      } else if (pick < 0.6) incidents.push({ kind: 'speedRestriction', segment: segs[Math.floor(rng() * segs.length)], extra: 1 + rng() * 10, from, to: from + 20 + rng() * 90 });
      else if (pick < 0.8) incidents.push({ kind: 'blockage', segment: segs[Math.floor(rng() * segs.length)], from, to: from + 5 + rng() * 40 });
      else incidents.push({ kind: 'platformClosure', station: base.network.stations[Math.floor(rng() * 10)].id, platforms: [1], from, to: from + 60 });
    }
    for (const p of policies) {
      const r = simulate({ ...base, incidents }, p);
      assert.equal(r.trains.length, trains.length);
      assert.equal(r.kpis.completed + (r.deadlock?.stuck.length ?? 0), trains.length);
      for (const t of r.trains) {
        for (let s = 1; s < t.stops.length; s++) {
          const prev = t.stops[s - 1].dep;
          const arr = t.stops[s].arr;
          if (prev !== null && arr !== null) assert.ok(arr > prev, `${t.id} arrives before it departs`);
        }
      }
    }
  }
});
