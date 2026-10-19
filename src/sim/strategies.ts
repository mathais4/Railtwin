import type { Policy, Scenario, SimOptions, SimResult } from '../model/types.ts';
import { DEFAULT_POLICY } from '../model/types.ts';
import { simulate, withoutIncidents } from './simulator.ts';
import { impactVsBaseline, type TrainImpact } from './metrics.ts';

export interface NamedPolicy {
  id: string;
  name: string;
  description: string;
  policy: Policy;
}

export const PRESET_POLICIES: NamedPolicy[] = [
  {
    id: 'timetable',
    name: 'Run as timetabled',
    description: 'First come, first served. No connection holds, no platform changes.',
    policy: { ...DEFAULT_POLICY },
  },
  {
    id: 'hold',
    name: 'Hold connections',
    description: 'Outbound trains wait for late feeders, up to each connection’s hold limit.',
    policy: { ...DEFAULT_POLICY, holdConnections: true },
  },
  {
    id: 'platforms',
    name: 'Flexible platforms',
    description: 'Trains take any free platform when their planned one is occupied or closed.',
    policy: { ...DEFAULT_POLICY, allowPlatformChange: true },
  },
  {
    id: 'priority',
    name: 'Prioritise fast trains',
    description: 'Contested track goes to higher-priority services; slower trains yield to approaching ones.',
    policy: { ...DEFAULT_POLICY, dispatch: 'priority' },
  },
  {
    id: 'integrated',
    name: 'Integrated control',
    description: 'Holds, flexible platforms and priority dispatch together.',
    policy: { ...DEFAULT_POLICY, holdConnections: true, allowPlatformChange: true, dispatch: 'priority' },
  },
];

export interface ComparedRun {
  id: string;
  name: string;
  description: string;
  policy: Policy;
  result: SimResult;
  impact: TrainImpact[];
}

export interface Comparison {
  baseline: SimResult;
  runs: ComparedRun[];
  /** Id of the run with the lowest passenger-weighted delay. */
  bestId: string;
}

/** Runs the undisrupted baseline plus every candidate response, so they can be compared like-for-like. */
export function compareResponses(
  scenario: Scenario,
  policies: NamedPolicy[] = PRESET_POLICIES,
  options: SimOptions = {},
): Comparison {
  const baseline = simulate(withoutIncidents(scenario), DEFAULT_POLICY, options);
  const runs = policies.map((p) => {
    const result = simulate(scenario, p.policy, options);
    return { ...p, result, impact: impactVsBaseline(result, baseline) };
  });
  const best = runs.reduce((a, b) => (cost(b.result) < cost(a.result) ? b : a));
  return { baseline, runs, bestId: best.id };
}

/** Objective used for ranking and optimisation: passenger-weighted delay, with gridlock treated as unacceptable. */
export function cost(r: SimResult): number {
  return r.kpis.passengerDelayMinutes + (r.kpis.deadlocked ? 1_000_000 : 0);
}
