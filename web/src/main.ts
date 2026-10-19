import type { Incident, Policy, Scenario, SimResult } from '../../src/model/types.ts';
import { DEFAULT_POLICY } from '../../src/model/types.ts';
import { builtInScenarios, CONTROL_POLICY } from '../../src/data/scenarios.ts';
import { simulate, withoutIncidents } from '../../src/sim/simulator.ts';
import { cost, PRESET_POLICIES } from '../../src/sim/strategies.ts';
import { optimise } from '../../src/sim/optimiser.ts';
import { replay } from '../../src/sim/replay.ts';
import { impactVsBaseline } from '../../src/sim/metrics.ts';
import { NetworkGraph } from '../../src/graph/networkGraph.ts';

// ------------------------------------------------------------ helpers

const $ = <T extends HTMLElement | SVGElement = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hhmm = (m: number | null | undefined) => {
  if (m === null || m === undefined) return '—';
  const r = Math.round(m);
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
};
const fmtInt = (n: number) => n.toLocaleString('en-IE');
const signed = (n: number, dp = 0) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toFixed(dp);
const delayClass = (d: number | null) => (d === null ? 'bad' : d > 10 ? 'bad' : d >= 3 ? 'warn' : 'ok');
const KIND_LABEL: Record<string, string> = { intercity: 'Intercity', local: 'Stopper', branch: 'Branch', coast: 'Coast', freight: 'Freight' };

// ------------------------------------------------------------ state

interface Entry { id: string; name: string; description: string; policy: Policy; result: SimResult }

const state = {
  scenario: builtInScenarios[0] as Scenario,
  policy: { ...DEFAULT_POLICY } as Policy,
  activePreset: 'timetable' as string | null,
  result: null as SimResult | null,
  baseline: null as SimResult | null,
  presets: [] as Entry[],
  optimised: null as (Entry & { steps: { label: string; cost: number }[]; evaluations: number; ms: number }) | null,
  time: 450,
  playing: 0,
};

// ------------------------------------------------------------ incidents

function incidentText(inc: Incident, sc: Scenario): { kind: string; text: string; when: string } {
  const st = (id: string) => sc.network.stations.find((s) => s.id === id)?.name ?? id;
  const seg = (id: string) => {
    const s = sc.network.segments.find((x) => x.id === id);
    return s ? `${st(s.from)}–${st(s.to)}` : id;
  };
  switch (inc.kind) {
    case 'trainDelay': {
      const t = sc.timetable.trains.find((x) => x.id === inc.train);
      return { kind: 'Late start', text: `${t?.name ?? inc.train}: ${inc.minutes} min late from ${st(t?.stops[inc.stopIndex].station ?? '')}`, when: inc.note ?? '' };
    }
    case 'speedRestriction':
      return { kind: 'Speed restriction', text: `${seg(inc.segment)}: +${inc.extra} min per train`, when: `${hhmm(inc.from)}–${hhmm(inc.to)}${inc.note ? ' · ' + inc.note : ''}` };
    case 'blockage':
      return { kind: 'Line blocked', text: seg(inc.segment), when: `${hhmm(inc.from)}–${hhmm(inc.to)}${inc.note ? ' · ' + inc.note : ''}` };
    case 'platformClosure':
      return { kind: 'Platforms closed', text: `${st(inc.station)} platform${inc.platforms.length > 1 ? 's' : ''} ${inc.platforms.join(', ')}`, when: `${hhmm(inc.from)}–${hhmm(inc.to)}${inc.note ? ' · ' + inc.note : ''}` };
  }
}

// ------------------------------------------------------------ running

function samePolicy(a: Policy, b: Policy) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function loadScenario(id: string) {
  state.scenario = builtInScenarios.find((s) => s.id === id)!;
  state.baseline = simulate(withoutIncidents(state.scenario), DEFAULT_POLICY);
  state.presets = PRESET_POLICIES.map((p) => ({ ...p, result: simulate(state.scenario, p.policy) }));
  state.optimised = null;
  $('opt-result').hidden = true;
  const firstIncident = Math.min(...state.scenario.incidents.map((i) => ('from' in i ? i.from : state.scenario.timetable.trains.find((t) => t.id === i.train)!.stops[0].dep!)));
  state.time = Math.max(380, Math.min(560, firstIncident + 25));
  renderScenario();
  applyPolicy(PRESET_POLICIES[0].policy, 'timetable');
}

function applyPolicy(policy: Policy, presetId: string | null) {
  state.policy = policy;
  const known = [...state.presets, ...(state.optimised ? [state.optimised] : [])].find((e) => samePolicy(e.policy, policy));
  state.activePreset = presetId ?? known?.id ?? null;
  state.result = known ? known.result : simulate(state.scenario, policy);
  syncToggles();
  renderAll();
}

function syncToggles() {
  ($('opt-hold') as HTMLInputElement).checked = state.policy.holdConnections;
  ($('opt-plat') as HTMLInputElement).checked = state.policy.allowPlatformChange;
  ($('opt-dispatch') as HTMLSelectElement).value = state.policy.dispatch;
}

function togglesChanged() {
  const policy: Policy = {
    ...DEFAULT_POLICY,
    holdConnections: ($('opt-hold') as HTMLInputElement).checked,
    allowPlatformChange: ($('opt-plat') as HTMLInputElement).checked,
    dispatch: ($('opt-dispatch') as HTMLSelectElement).value as Policy['dispatch'],
    interventions: [],
  };
  const preset = PRESET_POLICIES.find((p) => samePolicy(p.policy, policy));
  applyPolicy(policy, preset?.id ?? null);
}

function runOptimiser() {
  const btn = $('optimise') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Searching…';
  setTimeout(() => {
    const o = optimise(state.scenario, DEFAULT_POLICY, { maxEvaluations: 400 });
    state.optimised = {
      id: 'optimised',
      name: 'Optimised plan',
      description: '',
      policy: o.policy,
      result: o.result,
      steps: o.steps,
      evaluations: o.evaluations,
      ms: o.elapsedMs,
    };
    btn.disabled = false;
    btn.textContent = 'Find best response';
    const box = $('opt-result');
    box.hidden = false;
    box.innerHTML = `<div class="label">Search: ${o.evaluations} simulations in ${Math.round(o.elapsedMs)} ms</div>
      <ol class="opt-steps">${o.steps
        .slice(1)
        .map((s) => `<li>${esc(s.label)} <span class="c">→ ${fmtInt(s.cost)}</span></li>`)
        .join('') || '<li>No action beats running as timetabled.</li>'}</ol>`;
    applyPolicy(o.policy, 'optimised');
  }, 30);
}

// ------------------------------------------------------------ rendering: rail

function renderScenario() {
  const sc = state.scenario;
  $('scn-desc').textContent = sc.description;
  $('incidents').innerHTML = sc.incidents
    .map((i) => {
      const t = incidentText(i, sc);
      return `<li><span class="kind">${esc(t.kind)}</span><span>${esc(t.text)}</span>${t.when ? `<span class="when">${esc(t.when)}</span>` : ''}</li>`;
    })
    .join('');
}

function renderPresets() {
  const bestId = state.presets.reduce((a, b) => (cost(b.result) < cost(a.result) ? b : a)).id;
  $('presets').innerHTML = state.presets
    .map(
      (p) => `<button class="preset${p.id === bestId ? ' best' : ''}" data-id="${p.id}" aria-pressed="${state.activePreset === p.id}">
        <strong>${esc(p.name)}</strong><span class="pm">${p.result.kpis.deadlocked ? 'gridlock' : fmtInt(p.result.kpis.passengerDelayMinutes)}</span>
        <small>${esc(p.description)}</small></button>`,
    )
    .join('');
}

// ------------------------------------------------------------ rendering: KPIs

function renderKpis() {
  const k = state.result!.kpis;
  const ref = state.presets[0].result.kpis;
  const delta = (v: number, r: number, lowerIsBetter: boolean, unit = '') => {
    if (state.activePreset === 'timetable') return `<span class="d">vs. no action</span>`;
    const d = v - r;
    if (Math.abs(d) < 0.05) return `<span class="d">same as no action</span>`;
    const good = lowerIsBetter ? d < 0 : d > 0;
    return `<span class="d ${good ? 'good' : 'bad'}">${signed(d, Number.isInteger(d) ? 0 : 1)}${unit} vs. no action</span>`;
  };
  const tiles = [
    ['Punctual (≤5 min)', `${k.punctualityPct}%`, delta(k.punctualityPct, ref.punctualityPct, false, ' pts')],
    ['Train delay', `${fmtInt(Math.round(k.totalDelayMinutes))}<small style="font-size:15px"> min</small>`, delta(k.totalDelayMinutes, ref.totalDelayMinutes, true)],
    ['Knock-on trains', String(k.knockOnTrains), delta(k.knockOnTrains, ref.knockOnTrains, true)],
    ['Missed connections', String(k.connectionsMissed), delta(k.connectionsMissed, ref.connectionsMissed, true)],
    ['Passenger-minutes lost', fmtInt(k.passengerDelayMinutes), delta(k.passengerDelayMinutes, ref.passengerDelayMinutes, true)],
  ];
  $('kpis').innerHTML = tiles.map(([l, v, d]) => `<div class="kpi"><span class="label">${l}</span><span class="v">${v}</span>${d}</div>`).join('');
  const g = $('gridlock');
  const dl = state.result!.deadlock;
  g.hidden = !dl;
  if (dl) g.textContent = `Gridlock: ${dl.cycle.join(' and ')} are waiting for each other; ${dl.stuck.length} trains never reach their destination.`;
}

// ------------------------------------------------------------ rendering: map

const MAP = { w: 900, h: 380, pad: 46 };
let mapProj: (x: number, y: number) => [number, number] = (x, y) => [x, y];

function buildMap() {
  const net = state.scenario.network;
  const xs = net.stations.map((s) => s.x);
  const ys = net.stations.map((s) => s.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (MAP.w - 2 * MAP.pad) / (x1 - x0);
  const sy = (MAP.h - 2 * MAP.pad) / (y1 - y0);
  mapProj = (x, y) => [MAP.pad + (x - x0) * sx, MAP.pad + (y - y0) * sy];
}

function trainPosition(r: SimResult, trainId: string, t: number): [number, number] | null {
  const tr = r.trains.find((x) => x.id === trainId)!;
  const st = (id: string) => state.scenario.network.stations.find((s) => s.id === id)!;
  const first = tr.stops[0];
  const last = tr.stops[tr.stops.length - 1];
  if (first.dep === null || t < first.dep - 5) return null;
  if (last.arr !== null && t > last.arr + 3) return null;
  for (const m of r.movements) {
    if (m.train !== trainId || t < m.enter || t >= m.exit) continue;
    const seg = state.scenario.network.segments.find((s) => s.id === m.segment)!;
    const a = st(m.dir === 0 ? seg.from : seg.to);
    const b = st(m.dir === 0 ? seg.to : seg.from);
    const f = Math.min(1, (t - m.enter) / Math.max(0.01, m.reach - m.enter));
    return mapProj(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
  }
  for (const s of tr.stops) {
    const from = s.arr ?? (s.dep !== null ? s.dep - 5 : null);
    const to = s.dep ?? (s.arr !== null ? s.arr + 3 : null);
    if (from !== null && to !== null && t >= from && t <= to) {
      const p = st(s.station);
      return mapProj(p.x, p.y);
    }
  }
  return null;
}

/** Delay of a train at time t: lateness of its most recent timed event. */
function delayAt(r: SimResult, trainId: string, t: number): number {
  const tr = r.trains.find((x) => x.id === trainId)!;
  let d = 0;
  for (const s of tr.stops) {
    if (s.arr !== null && s.arr <= t && s.arrDelay !== null) d = s.arrDelay;
    if (s.dep !== null && s.dep <= t && s.depDelay !== null) d = s.depDelay;
    // Still waiting to leave: its delay is growing.
    if (s.dep === null && s.schedDep !== null && s.arr !== null && t > s.schedDep) d = t - s.schedDep;
    if (s.dep !== null && s.schedDep !== null && t < s.dep && t > s.schedDep && (s.arr === null || s.arr <= t)) d = t - s.schedDep;
  }
  return d;
}

function renderMap() {
  const sc = state.scenario;
  const r = state.result!;
  const t = state.time;
  const st = (id: string) => sc.network.stations.find((s) => s.id === id)!;
  const activeIncidentSegs = new Set(
    sc.incidents.flatMap((i) => ((i.kind === 'speedRestriction' || i.kind === 'blockage') && t >= i.from && t < i.to ? [i.segment] : [])),
  );
  const closedStations = new Set(sc.incidents.flatMap((i) => (i.kind === 'platformClosure' && t >= i.from && t < i.to ? [i.station] : [])));

  let svg = '';
  for (const seg of sc.network.segments) {
    const [ax, ay] = mapProj(st(seg.from).x, st(seg.from).y);
    const [bx, by] = mapProj(st(seg.to).x, st(seg.to).y);
    const hit = activeIncidentSegs.has(seg.id);
    svg += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${hit ? 'var(--bad)' : 'var(--rule-strong)'}" stroke-width="${seg.tracks === 2 ? 6 : 3}" stroke-linecap="round" ${seg.tracks === 1 ? 'stroke-dasharray="7 5"' : ''}/>`;
    if (seg.tracks === 2) svg += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="var(--panel)" stroke-width="1.5"/>`;
  }
  for (const s of sc.network.stations) {
    const [x, y] = mapProj(s.x, s.y);
    const closed = closedStations.has(s.id);
    const below = s.y >= 28;
    svg += `<rect x="${x - 7}" y="${y - 7}" width="14" height="14" rx="2" fill="var(--panel)" stroke="${closed ? 'var(--bad)' : 'var(--ink)'}" stroke-width="2"/>`;
    svg += `<text x="${x}" y="${below ? y + 26 : y - 15}" text-anchor="middle" font-family="var(--font-display)" font-weight="600" font-size="15">${esc(s.name)}</text>`;
    svg += `<text x="${x}" y="${below ? y + 40 : y - 30}" text-anchor="middle" font-family="var(--font-data)" font-size="10.5" style="fill:var(--muted)">${s.platforms} plat${closed ? ' · closures' : ''}</text>`;
  }
  const dots: string[] = [];
  for (const tr of sc.timetable.trains) {
    const p = trainPosition(r, tr.id, t);
    if (!p) continue;
    const d = delayAt(r, tr.id, t);
    const color = d > 10 ? 'var(--bad)' : d >= 3 ? 'var(--warn)' : 'var(--ok)';
    const rad = tr.kind === 'intercity' ? 7 : 5.5;
    dots.push(`<g><title>${esc(tr.name)} — ${d >= 0.5 ? Math.round(d) + ' min late' : 'on time'}</title><circle cx="${p[0]}" cy="${p[1]}" r="${rad}" fill="${color}" stroke="var(--panel)" stroke-width="2"/></g>`);
  }
  $('map').innerHTML = svg + dots.join('');
  $('map-time').textContent = hhmm(t);
  $('clock').textContent = hhmm(t);
  ($('time') as HTMLInputElement).value = String(t);
}

// ------------------------------------------------------------ rendering: train graph

const MAINLINE = ['NGT', 'ASH', 'MIL', 'RVC', 'ELM', 'STB'];
const G = { w: 1100, h: 360, left: 130, right: 16, top: 18, bottom: 34, t0: 360, t1: 600 };

function renderGraph() {
  const sc = state.scenario;
  const r = state.result!;
  const graph = new NetworkGraph(sc.network);
  const dist = new Map<string, number>([[MAINLINE[0], 0]]);
  for (let i = 1; i < MAINLINE.length; i++) {
    const seg = sc.network.segments.find((s) => (s.from === MAINLINE[i - 1] && s.to === MAINLINE[i]) || (s.to === MAINLINE[i - 1] && s.from === MAINLINE[i]))!;
    dist.set(MAINLINE[i], dist.get(MAINLINE[i - 1])! + graph.segmentLength(seg));
  }
  const total = dist.get(MAINLINE[MAINLINE.length - 1])!;
  const X = (t: number) => G.left + ((t - G.t0) / (G.t1 - G.t0)) * (G.w - G.left - G.right);
  const Y = (d: number) => G.top + (d / total) * (G.h - G.top - G.bottom);
  const mainSegs = new Set(MAINLINE.slice(1).map((s, i) => sc.network.segments.find((x) => (x.from === MAINLINE[i] && x.to === s) || (x.to === MAINLINE[i] && x.from === s))!.id));

  let svg = '';
  for (let t = G.t0; t <= G.t1; t += 15) {
    const major = t % 60 === 0;
    svg += `<line x1="${X(t)}" y1="${G.top}" x2="${X(t)}" y2="${G.h - G.bottom}" stroke="var(--rule)" stroke-width="${major ? 1.2 : 0.6}"/>`;
    if (major || t % 30 === 0) svg += `<text x="${X(t)}" y="${G.h - G.bottom + 18}" text-anchor="middle" font-family="var(--font-data)" font-size="11" style="fill:var(--muted)">${hhmm(t)}</text>`;
  }
  for (const id of MAINLINE) {
    const y = Y(dist.get(id)!);
    svg += `<line x1="${G.left}" y1="${y}" x2="${G.w - G.right}" y2="${y}" stroke="var(--rule-strong)" stroke-width="0.8"/>`;
    svg += `<text x="${G.left - 10}" y="${y + 4}" text-anchor="end" font-family="var(--font-display)" font-weight="600" font-size="13">${esc(sc.network.stations.find((s) => s.id === id)!.name)}</text>`;
  }
  for (const inc of sc.incidents) {
    if (inc.kind === 'speedRestriction' || inc.kind === 'blockage') {
      if (!mainSegs.has(inc.segment)) continue;
      const seg = sc.network.segments.find((s) => s.id === inc.segment)!;
      const ya = Y(dist.get(seg.from)!);
      const yb = Y(dist.get(seg.to)!);
      svg += `<rect x="${X(Math.max(G.t0, inc.from))}" y="${Math.min(ya, yb)}" width="${X(Math.min(G.t1, inc.to)) - X(Math.max(G.t0, inc.from))}" height="${Math.abs(yb - ya)}" fill="var(--bad)" opacity="0.12"/>`;
    }
  }

  svg += `<defs><clipPath id="plot"><rect x="${G.left}" y="${G.top - 8}" width="${G.w - G.left - G.right}" height="${G.h - G.top - G.bottom + 16}"/></clipPath></defs><g clip-path="url(#plot)">`;
  const kinds = new Set<string>();
  const clamp = (pts: [number, number][]) => pts.map(([t, d]) => `${X(t).toFixed(1)},${Y(d).toFixed(1)}`).join(' ');
  for (const tr of sc.timetable.trains) {
    if (!tr.stops.every((s) => dist.has(s.station))) continue;
    if (tr.route && tr.route.some((leg) => leg.some((s) => !mainSegs.has(s)))) continue;
    kinds.add(tr.kind);
    const color = `var(--k-${tr.kind})`;
    // Planned path from the timetable.
    const planned: [number, number][] = [];
    for (const s of tr.stops) {
      if (s.arr !== undefined) planned.push([s.arr, dist.get(s.station)!]);
      if (s.dep !== undefined) planned.push([s.dep, dist.get(s.station)!]);
    }
    svg += `<polyline points="${clamp(planned)}" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>`;
    // Simulated path, broken wherever the train leaves the main line.
    const res = r.trains.find((x) => x.id === tr.id)!;
    const moves = r.movements.filter((m) => m.train === tr.id);
    const runs: [number, number][][] = [];
    let cur: [number, number][] = [];
    for (const m of moves) {
      const seg = sc.network.segments.find((s) => s.id === m.segment)!;
      if (!mainSegs.has(seg.id)) {
        if (cur.length) runs.push(cur);
        cur = [];
        continue;
      }
      const a = dist.get(m.dir === 0 ? seg.from : seg.to)!;
      const b = dist.get(m.dir === 0 ? seg.to : seg.from)!;
      cur.push([m.enter, a], [m.reach, b]);
      if (m.exit > m.reach + 0.01) cur.push([m.exit, b]);
    }
    if (cur.length) runs.push(cur);
    const late = res.finalDelay === null || res.finalDelay >= 3;
    for (const run of runs) {
      svg += `<polyline points="${clamp(run)}" fill="none" stroke="${color}" stroke-width="${late ? 2.6 : 1.8}" stroke-linejoin="round"><title>${esc(tr.name)} — ${res.finalDelay === null ? 'did not arrive' : res.finalDelay >= 0.5 ? Math.round(res.finalDelay) + ' min late at destination' : 'on time at destination'}</title></polyline>`;
    }
  }
  svg += '</g>';
  svg += `<line x1="${X(state.time)}" y1="${G.top - 6}" x2="${X(state.time)}" y2="${G.h - G.bottom}" stroke="var(--accent)" stroke-width="1.5"/>`;
  $('graph').innerHTML = svg;
  $('graph-legend').innerHTML = [...kinds].map((k) => `<span><i style="background:var(--k-${k})"></i>${KIND_LABEL[k] ?? k}</span>`).join('') + `<span><i class="dash"></i>Timetable</span><span><i style="background:var(--bad);opacity:.35;height:8px"></i>Restricted section</span>`;
}

// ------------------------------------------------------------ rendering: tables

function renderCompare() {
  const rows = [...state.presets, ...(state.optimised ? [state.optimised] : [])];
  const best = rows.reduce((a, b) => (cost(b.result) < cost(a.result) ? b : a)).id;
  $('compare').innerHTML =
    `<thead><tr><th>Response</th><th class="n">Punctual</th><th class="n">Knock-on</th><th class="n">Missed</th><th class="n">Pass.-min</th></tr></thead><tbody>` +
    rows
      .map((e) => {
        const k = e.result.kpis;
        return `<tr class="clickable${e.id === state.activePreset ? ' current' : ''}" data-id="${e.id}" tabindex="0">
          <td>${esc(e.name)} ${e.id === best ? '<span class="pill ok">best</span>' : ''}${k.deadlocked ? ' <span class="pill bad">gridlock</span>' : ''}</td>
          <td class="n">${k.punctualityPct}%</td><td class="n">${k.knockOnTrains}</td><td class="n">${k.connectionsMissed}</td><td class="n">${fmtInt(k.passengerDelayMinutes)}</td></tr>`;
      })
      .join('') +
    '</tbody>';
}

function renderWorst() {
  const impact = impactVsBaseline(state.result!, state.baseline!).filter((t) => t.impact === null || t.impact >= 0.5).slice(0, 8);
  const byId = new Map(state.result!.trains.map((t) => [t.id, t]));
  $('worst').innerHTML = impact.length
    ? `<thead><tr><th>Train</th><th>Cause</th><th class="n">Extra min</th></tr></thead><tbody>` +
      impact
        .map((t) => {
          const tr = byId.get(t.id)!;
          const top = Object.entries(tr.waitByKind).sort((a, b) => b[1] - a[1])[0];
          const cause = t.directlyAffected ? 'incident' : top ? top[0].replace(/([A-Z])/g, ' $1').toLowerCase() : 'knock-on';
          return `<tr><td>${esc(t.name)}</td><td><span class="pill ${t.directlyAffected ? 'bad' : 'warn'}">${esc(cause)}</span></td><td class="n">${t.impact === null ? 'stuck' : '+' + t.impact.toFixed(1)}</td></tr>`;
        })
        .join('') +
      '</tbody>'
    : '<tbody><tr><td>No train is more than half a minute worse off than on a normal day.</td></tr></tbody>';
}

function renderChain() {
  const name = (id: string) => state.scenario.timetable.trains.find((t) => t.id === id)?.name ?? id;
  const edges = state.result!.knockOn.filter((e) => e.minutes >= 0.5).slice(0, 8);
  $('chain').innerHTML = edges.length
    ? edges.map((e) => `<li><span>${esc(name(e.from))}<span class="arrow">→</span>${esc(name(e.to))}</span><span class="num">${e.minutes.toFixed(1)}</span></li>`).join('')
    : '<li><span>No train held up another by more than half a minute.</span><span></span></li>';
}

const replayCache = new Map<string, ReturnType<typeof replay>>();
function renderReplay() {
  const sc = state.scenario;
  let r = replayCache.get(sc.id);
  if (!r) {
    r = replay(sc, CONTROL_POLICY);
    replayCache.set(sc.id, r);
  }
  const rows: [string, string, number][] = [
    ['RailTwin', 'model', r.disrupted.model.mae],
    ['Timetable', '', r.disrupted.timetable.mae],
    ['Delay persists', '', r.disrupted.persistence.mae],
  ];
  const max = Math.max(...rows.map((x) => x[2]), 1);
  $('replay').innerHTML =
    `<div class="label">Late-running trains only (${r.disrupted.model.n} times)</div>` +
    rows.map(([l, c, v]) => `<div class="bar-row"><span>${l}</span><div class="bar-track"><div class="bar-fill ${c}" style="width:${(100 * v) / max}%"></div></div><span class="num">${v.toFixed(1)}</span></div>`).join('') +
    `<div class="label" style="margin-top:4px">Every timed stop (${r.model.n} times)</div>` +
    `<div class="bar-row"><span>RailTwin</span><div class="bar-track"><div class="bar-fill model" style="width:${(100 * r.model.mae) / max}%"></div></div><span class="num">${r.model.mae.toFixed(2)}</span></div>` +
    `<div class="bar-row"><span>Timetable</span><div class="bar-track"><div class="bar-fill" style="width:${(100 * r.timetable.mae) / max}%"></div></div><span class="num">${r.timetable.mae.toFixed(2)}</span></div>`;
  $('replay-note').textContent = `${r.model.within2Pct}% of RailTwin's predictions land within 2 minutes of what happened. Bias ${signed(r.model.bias, 2)} min: the model ${r.model.bias < 0 ? 'runs slightly optimistic, because real trains overrun a little everywhere' : 'runs slightly pessimistic'}.`;
}

function renderAll() {
  renderPresets();
  renderKpis();
  renderMap();
  renderGraph();
  renderCompare();
  renderWorst();
  renderChain();
  renderReplay();
}

// ------------------------------------------------------------ wiring

function setTime(t: number) {
  state.time = Math.max(355, Math.min(610, t));
  renderMap();
  const line = $('graph').querySelector('line:last-of-type');
  if (line) {
    const x = G.left + ((state.time - G.t0) / (G.t1 - G.t0)) * (G.w - G.left - G.right);
    line.setAttribute('x1', String(x));
    line.setAttribute('x2', String(x));
  }
}

function init() {
  const sel = $('scenario') as HTMLSelectElement;
  sel.innerHTML = builtInScenarios.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  sel.addEventListener('change', () => loadScenario(sel.value));
  $('presets').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('.preset') as HTMLElement | null;
    if (!b) return;
    const p = PRESET_POLICIES.find((x) => x.id === b.dataset.id)!;
    applyPolicy(p.policy, p.id);
  });
  const pick = (e: Event) => {
    const tr = (e.target as HTMLElement).closest('tr[data-id]') as HTMLElement | null;
    if (!tr) return;
    const entry = [...state.presets, ...(state.optimised ? [state.optimised] : [])].find((x) => x.id === tr.dataset.id);
    if (entry) applyPolicy(entry.policy, entry.id);
  };
  $('compare').addEventListener('click', pick);
  $('compare').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') pick(e);
  });
  for (const id of ['opt-hold', 'opt-plat', 'opt-dispatch']) $(id).addEventListener('change', togglesChanged);
  $('optimise').addEventListener('click', runOptimiser);
  $('time').addEventListener('input', (e) => setTime(Number((e.target as HTMLInputElement).value)));
  $('play').addEventListener('click', () => {
    const btn = $('play');
    if (state.playing) {
      clearInterval(state.playing);
      state.playing = 0;
      btn.textContent = '▶ Play';
      return;
    }
    btn.textContent = '❚❚ Pause';
    if (state.time >= 605) setTime(360);
    state.playing = window.setInterval(() => {
      if (state.time >= 610) {
        clearInterval(state.playing);
        state.playing = 0;
        btn.textContent = '▶ Play';
        return;
      }
      setTime(state.time + 0.5);
    }, 60);
  });
  buildMap();
  loadScenario(builtInScenarios[0].id);
}

init();
