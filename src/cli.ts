import { readFileSync } from 'node:fs';
import type { ObservedStopTime, Policy, Scenario } from './model/types.ts';
import { builtInScenarios, CONTROL_POLICY, getBuiltInScenario } from './data/scenarios.ts';
import { simulate, withoutIncidents } from './sim/simulator.ts';
import { compareResponses, PRESET_POLICIES } from './sim/strategies.ts';
import { optimise } from './sim/optimiser.ts';
import { calibrate, replay } from './sim/replay.ts';
import { impactVsBaseline } from './sim/metrics.ts';
import { DEFAULT_POLICY } from './model/types.ts';
import { connect } from './db/client.ts';
import { loadScenario, replaceObserved } from './db/repository.ts';

const USAGE = `RailTwin CLI

  list                                    built-in scenarios
  simulate <scenario> [--policy <id>]     run one response (${PRESET_POLICIES.map((p) => p.id).join(', ')})
  compare <scenario>                      run every preset response side by side
  optimise <scenario>                     search for a better set of dispatcher actions
  replay <scenario>                       score predictions against the observed day
  calibrate                               fit run-time scale/dwell on 3 days, test on the other 2
  import-observed <scenario> <file.csv>   load observed times into Postgres (needs DATABASE_URL)

CSV for import-observed: train_id,seq,arr,dep  (times as HH:MM[:SS] or minutes after midnight)`;

const fmt = (m: number | null | undefined) => {
  if (m === null || m === undefined) return '   –  ';
  const h = Math.floor(m / 60);
  const mm = m - h * 60;
  return `${String(h).padStart(2, '0')}:${mm.toFixed(1).padStart(4, '0')}`;
};
const pad = (s: unknown, n: number) => String(s).padEnd(n);

async function getScenario(id: string | undefined): Promise<Scenario> {
  if (!id) throw new Error('scenario id required\n\n' + USAGE);
  if (process.env.DATABASE_URL) {
    const db = await connect(process.env.DATABASE_URL);
    const sc = await loadScenario(db, id);
    await db.end();
    if (sc) return sc;
  }
  const sc = getBuiltInScenario(id);
  if (!sc) throw new Error(`unknown scenario ${id}; try: ${builtInScenarios.map((s) => s.id).join(', ')}`);
  return sc;
}

function policyArg(args: string[]): { name: string; policy: Policy } {
  const i = args.indexOf('--policy');
  if (i < 0) return { name: 'timetable', policy: DEFAULT_POLICY };
  const id = args[i + 1];
  if (id === 'control') return { name: 'control', policy: CONTROL_POLICY };
  const p = PRESET_POLICIES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown policy ${id}`);
  return { name: p.id, policy: p.policy };
}

function kpiLine(k: ReturnType<typeof simulate>['kpis']) {
  return `punctual ${k.punctualityPct}% · delay ${k.totalDelayMinutes} min · knock-on ${k.knockOnTrains} · missed connections ${k.connectionsMissed} · passenger-min ${k.passengerDelayMinutes}${k.deadlocked ? ' · GRIDLOCK' : ''}`;
}

/** Parses "07:42", "07:42:30" or "462" into minutes after midnight. */
export function parseTime(s: string | undefined): number | undefined {
  if (s === undefined || s.trim() === '') return undefined;
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`bad time "${s}"`);
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3] ?? 0) / 60;
}

export function parseObservedCsv(text: string): ObservedStopTime[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines.shift()?.split(',').map((h) => h.trim().toLowerCase());
  if (!header || !['train_id', 'seq'].every((h) => header.includes(h))) throw new Error('CSV needs header train_id,seq,arr,dep');
  const col = (name: string) => header.indexOf(name);
  return lines.map((line, n) => {
    const f = line.split(',');
    const seq = Number(f[col('seq')]);
    if (!Number.isInteger(seq) || seq < 0) throw new Error(`line ${n + 2}: bad seq`);
    return {
      train: f[col('train_id')].trim(),
      seq,
      arr: col('arr') >= 0 ? parseTime(f[col('arr')]) : undefined,
      dep: col('dep') >= 0 ? parseTime(f[col('dep')]) : undefined,
    };
  });
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'list':
      for (const s of builtInScenarios) console.log(`${pad(s.id, 18)} ${s.name}`);
      return;

    case 'simulate': {
      const sc = await getScenario(args[0]);
      const { name, policy } = policyArg(args);
      const r = simulate(sc, policy);
      const base = simulate(withoutIncidents(sc), DEFAULT_POLICY, { lean: true });
      console.log(`${sc.name} — ${name}\n${kpiLine(r.kpis)}\n(${r.kpis.events} events in ${r.runtimeMs.toFixed(1)} ms)\n`);
      console.log('Most affected trains (extra minutes vs. undisrupted):');
      for (const t of impactVsBaseline(r, base).slice(0, 10)) {
        if ((t.impact ?? 1) <= 0.05) break;
        console.log(`  ${pad(t.name, 46)} ${t.impact === null ? 'did not arrive' : `+${t.impact.toFixed(1)}`}${t.directlyAffected ? '' : '  (knock-on)'}`);
      }
      console.log('\nBiggest knock-on links:');
      for (const e of r.knockOn.slice(0, 8)) console.log(`  ${pad(e.from, 12)} → ${pad(e.to, 12)} ${e.minutes.toFixed(1)} min`);
      if (r.deadlock) console.log(`\nGridlock: ${r.deadlock.cycle.join(' ⇄ ')} (${r.deadlock.stuck.length} trains stuck)`);
      return;
    }

    case 'compare': {
      const sc = await getScenario(args[0]);
      const c = compareResponses(sc);
      console.log(`${sc.name}\n`);
      console.log(`${pad('response', 26)}${pad('punctual', 10)}${pad('delay', 9)}${pad('knock-on', 10)}${pad('missed', 8)}passenger-min`);
      for (const r of c.runs) {
        const k = r.result.kpis;
        console.log(`${pad((r.id === c.bestId ? '★ ' : '  ') + r.name, 26)}${pad(k.punctualityPct + '%', 10)}${pad(k.totalDelayMinutes, 9)}${pad(k.knockOnTrains, 10)}${pad(k.connectionsMissed, 8)}${k.passengerDelayMinutes}${k.deadlocked ? '  GRIDLOCK' : ''}`);
      }
      return;
    }

    case 'optimise': {
      const sc = await getScenario(args[0]);
      const o = optimise(sc);
      console.log(`${sc.name}: ${o.startCost} → ${o.bestCost} passenger-minutes (${o.evaluations} simulations, ${o.elapsedMs.toFixed(0)} ms)\n`);
      o.steps.forEach((s, i) => console.log(`  ${i === 0 ? ' ' : i + '.'} ${pad(s.label, 52)} ${s.cost}`));
      console.log(`\n${kpiLine(o.result.kpis)}`);
      return;
    }

    case 'replay': {
      const sc = await getScenario(args[0]);
      const r = replay(sc, CONTROL_POLICY);
      const row = (label: string, s: typeof r.model) => console.log(`  ${pad(label, 14)} MAE ${pad(s.mae.toFixed(2), 6)} RMSE ${pad(s.rmse.toFixed(2), 6)} bias ${pad(s.bias.toFixed(2), 6)} within 2 min ${s.within2Pct}%`);
      console.log(`${sc.name}: ${r.model.n} observed times\n\nAll points`);
      row('RailTwin', r.model);
      row('timetable', r.timetable);
      row('persistence', r.persistence);
      console.log(`\nDisrupted points only (observed ≥ 3 min late, n=${r.disrupted.model.n})`);
      row('RailTwin', r.disrupted.model);
      row('timetable', r.disrupted.timetable);
      row('persistence', r.disrupted.persistence);
      console.log('\nLargest misses:');
      for (const p of [...r.points].sort((a, b) => Math.abs(b.predicted! - b.observed) - Math.abs(a.predicted! - a.observed)).slice(0, 5)) {
        console.log(`  ${pad(p.train, 12)} ${pad(p.station, 4)} ${p.event} sched ${fmt(p.scheduled)} observed ${fmt(p.observed)} predicted ${fmt(p.predicted)}`);
      }
      return;
    }

    case 'calibrate': {
      const fit = builtInScenarios.slice(0, 3);
      const test = builtInScenarios.slice(3);
      const cal = calibrate(fit, CONTROL_POLICY);
      console.log(`fitted on ${fit.map((s) => s.id).join(', ')}: runTimeScale ${cal.runTimeScale}, extraDwell ${cal.extraDwell} (MAE ${cal.trainMae}, ${cal.evaluated} grid points)\n`);
      for (const sc of test) {
        const before = replay(sc, CONTROL_POLICY).model;
        const after = replay(sc, CONTROL_POLICY, { runTimeScale: cal.runTimeScale, extraDwell: cal.extraDwell }).model;
        console.log(`  held-out ${pad(sc.id, 18)} MAE ${before.mae} → ${after.mae}   bias ${before.bias} → ${after.bias}`);
      }
      return;
    }

    case 'import-observed': {
      const [id, file] = args;
      if (!id || !file) throw new Error(USAGE);
      if (!process.env.DATABASE_URL) throw new Error('import-observed needs DATABASE_URL');
      const rows = parseObservedCsv(readFileSync(file, 'utf8'));
      const db = await connect(process.env.DATABASE_URL);
      await replaceObserved(db, id, rows, 'import');
      await db.end();
      console.log(`imported ${rows.length} observed stop times into ${id}`);
      return;
    }

    default:
      console.log(USAGE);
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
