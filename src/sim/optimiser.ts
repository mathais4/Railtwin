import type { Intervention, Policy, Scenario, SimOptions, SimResult } from '../model/types.ts';
import { DEFAULT_POLICY } from '../model/types.ts';
import { NetworkGraph } from '../graph/networkGraph.ts';
import { simulate } from './simulator.ts';
import { cost } from './strategies.ts';

export interface Move {
  label: string;
  apply: (p: Policy) => Policy;
}

export interface OptimiseStep {
  label: string;
  cost: number;
}

export interface OptimiseResult {
  policy: Policy;
  result: SimResult;
  startCost: number;
  bestCost: number;
  steps: OptimiseStep[];
  evaluations: number;
  elapsedMs: number;
}

export interface OptimiseOptions {
  maxRounds?: number;
  maxEvaluations?: number;
  /** Minimum improvement (passenger-minutes) needed to accept a move. */
  minGain?: number;
  sim?: SimOptions;
}

const withIv = (iv: Intervention) => (p: Policy): Policy => ({ ...p, interventions: [...p.interventions, iv] });

/**
 * Generates candidate dispatcher actions from what went wrong in a simulated run:
 * missed or costly connections, trains that lost the most time to other trains,
 * trains caught by a restriction or blockage that could be rerouted, plus the
 * global policy switches.
 */
export function candidateMoves(scenario: Scenario, run: SimResult, current: Policy): Move[] {
  const moves: Move[] = [];

  if (!current.holdConnections) moves.push({ label: 'Hold connections (policy)', apply: (p) => ({ ...p, holdConnections: true }) });
  if (!current.allowPlatformChange) moves.push({ label: 'Allow platform changes (policy)', apply: (p) => ({ ...p, allowPlatformChange: true }) });
  if (current.dispatch !== 'priority') moves.push({ label: 'Priority dispatch (policy)', apply: (p) => ({ ...p, dispatch: 'priority' }) });

  const touched = new Set(
    current.interventions.flatMap((i) => ('connection' in i ? [i.connection] : 'train' in i ? [`${i.kind}:${i.train}`] : [])),
  );

  for (const c of run.connections) {
    if (touched.has(c.id)) continue;
    if (!c.made) moves.push({ label: `Hold ${c.toTrain} for ${c.fromTrain} at ${c.station}`, apply: withIv({ kind: 'hold', connection: c.id }) });
    else if (c.heldMinutes > 0) moves.push({ label: `Don't hold ${c.toTrain} for ${c.fromTrain}`, apply: withIv({ kind: 'release', connection: c.id }) });
  }

  // Trains that lost the most time to other trains are candidates for priority.
  const victimMinutes = new Map<string, number>();
  for (const e of run.knockOn) victimMinutes.set(e.to, (victimMinutes.get(e.to) ?? 0) + e.minutes);
  const pax = new Map(scenario.timetable.trains.map((t) => [t.id, t.passengers]));
  [...victimMinutes.entries()]
    .sort((a, b) => b[1] * (pax.get(b[0]) ?? 1) - a[1] * (pax.get(a[0]) ?? 1))
    .slice(0, 6)
    .forEach(([train]) => {
      if (!touched.has(`prioritise:${train}`)) moves.push({ label: `Prioritise ${train}`, apply: withIv({ kind: 'prioritise', train }) });
    });

  // Reroutes around restricted or blocked segments.
  const graph = new NetworkGraph(scenario.network);
  const badSegs = new Set(
    scenario.incidents.flatMap((i) => (i.kind === 'speedRestriction' || i.kind === 'blockage' ? [i.segment] : [])),
  );
  if (badSegs.size > 0) {
    const trainsOnBad = new Set(run.movements.filter((m) => badSegs.has(m.segment)).map((m) => m.train));
    for (const id of trainsOnBad) {
      if (touched.has(`reroute:${id}`)) continue;
      const train = scenario.timetable.trains.find((t) => t.id === id)!;
      const used = run.movements.filter((m) => m.train === id && badSegs.has(m.segment)).map((m) => m.segment);
      const avoid = new Set(used);
      const feasible = train.stops.slice(0, -1).every((s, i) => {
        const next = train.stops[i + 1].station;
        const normal = graph.shortestPath(s.station, next);
        const touchesBad = normal?.steps.some((st) => avoid.has(st.seg.id));
        return !touchesBad || graph.shortestPath(s.station, next, avoid) !== null;
      });
      if (feasible) moves.push({ label: `Reroute ${id} avoiding ${[...avoid].join(', ')}`, apply: withIv({ kind: 'reroute', train: id, avoid: [...avoid] }) });
    }
  }
  return moves;
}

/**
 * Greedy local search over dispatcher actions. Each round evaluates every
 * candidate move with a full simulation and keeps the one that most reduces
 * passenger-weighted delay; candidates are regenerated from the improved run.
 */
export function optimise(scenario: Scenario, start: Policy = DEFAULT_POLICY, opts: OptimiseOptions = {}): OptimiseResult {
  const t0 = performance.now();
  const maxRounds = opts.maxRounds ?? 6;
  const maxEvals = opts.maxEvaluations ?? 400;
  const minGain = opts.minGain ?? 1;
  const simOpts = opts.sim ?? {};

  let policy: Policy = { ...start, interventions: [...start.interventions] };
  let result = simulate(scenario, policy, simOpts);
  let best = cost(result);
  const startCost = best;
  const steps: OptimiseStep[] = [{ label: 'Starting policy', cost: best }];
  const used = new Set<string>();
  let evaluations = 1;

  for (let round = 0; round < maxRounds && evaluations < maxEvals; round++) {
    const moves = candidateMoves(scenario, result, policy).filter((m) => !used.has(m.label));
    let pick: { move: Move; policy: Policy; cost: number } | null = null;
    for (const move of moves) {
      if (evaluations >= maxEvals) break;
      const p = move.apply(policy);
      const c = cost(simulate(scenario, p, { ...simOpts, lean: true }));
      evaluations++;
      if (c < (pick?.cost ?? best - minGain)) pick = { move, policy: p, cost: c };
    }
    if (!pick) break;
    used.add(pick.move.label);
    policy = pick.policy;
    best = pick.cost;
    result = simulate(scenario, policy, simOpts);
    evaluations++;
    steps.push({ label: pick.move.label, cost: best });
  }

  return { policy, result, startCost, bestCost: best, steps, evaluations, elapsedMs: performance.now() - t0 };
}
