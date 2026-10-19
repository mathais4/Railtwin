import type { Incident, ObservedStopTime, Policy, Scenario } from '../model/types.ts';
import { DEFAULT_POLICY } from '../model/types.ts';
import { buildSampleTimetable, sampleNetwork } from './sampleNetwork.ts';
import observedData from './observed.json' with { type: 'json' };

const h = (hh: number, mm: number) => hh * 60 + mm;

export interface ScenarioSpec {
  id: string;
  name: string;
  description: string;
  /** What the control room was told — the model's only input. */
  incidents: Incident[];
  /**
   * What actually happened, used only to synthesise the "observed" day. Real
   * incidents are rarely reported with exact magnitudes, so these differ a little.
   */
  actual: Incident[];
}

export const scenarioSpecs: ScenarioSpec[] = [
  {
    id: 'late-intercity',
    name: 'Late-running intercity',
    description: 'The 07:00 Northgate–Stonebridge intercity leaves 12 minutes late after a crew delay. Its connections into the Lough Arden branch and the Westhaven coast line are at risk: hold them, or keep the branch and coast services on time?',
    incidents: [{ kind: 'trainDelay', train: 'IC-D-0700', stopIndex: 0, minutes: 12, note: 'Crew late on duty' }],
    actual: [{ kind: 'trainDelay', train: 'IC-D-0700', stopIndex: 0, minutes: 13 }],
  },
  {
    id: 'signal-failure',
    name: 'Signal failure, Millbrook–Riverside',
    description: 'Signalling fails between Millbrook and Riverside Central from 07:00 to 08:30; trains are cautioned through, adding 8 minutes each way. The single-track cut-off is available as a diversion.',
    incidents: [{ kind: 'speedRestriction', segment: 'MIL-RVC', extra: 8, from: h(7, 0), to: h(8, 30), note: 'Track circuit failure' }],
    actual: [{ kind: 'speedRestriction', segment: 'MIL-RVC', extra: 9, from: h(7, 0), to: h(8, 40) }],
  },
  {
    id: 'branch-blockage',
    name: 'Fallen tree on the Lough Arden branch',
    description: 'A tree blocks the single line between Corran and Lough Arden from 07:15 to 07:50. Branch trains are stranded and main-line connections at Ashby Junction are at risk.',
    incidents: [{ kind: 'blockage', segment: 'COR-LGA', from: h(7, 15), to: h(7, 50), note: 'Tree on line' }],
    actual: [{ kind: 'blockage', segment: 'COR-LGA', from: h(7, 15), to: h(7, 56) }],
  },
  {
    id: 'platform-closure',
    name: 'Four platforms closed at Riverside Central',
    description: 'A trespass incident closes platforms 1–4 of 5 at Riverside Central from 07:00 to 09:00, squeezing every service through the one that remains.',
    incidents: [{ kind: 'platformClosure', station: 'RVC', platforms: [1, 2, 3, 4], from: h(7, 0), to: h(9, 0), note: 'Trespass, police attending' }],
    actual: [{ kind: 'platformClosure', station: 'RVC', platforms: [1, 2, 3, 4], from: h(7, 0), to: h(9, 5) }],
  },
  {
    id: 'morning-meltdown',
    name: 'Morning meltdown',
    description: 'Several things go wrong at once: the 08:00 intercity is 12 minutes late away, a temporary speed restriction slows Elm Park–Stonebridge, and Northgate platform 1 is out of use.',
    incidents: [
      { kind: 'trainDelay', train: 'IC-D-0800', stopIndex: 0, minutes: 12, note: 'Late inbound stock' },
      { kind: 'speedRestriction', segment: 'ELM-STB', extra: 5, from: h(7, 30), to: h(9, 30), note: 'Heat-related speed restriction' },
      { kind: 'platformClosure', station: 'NGT', platforms: [1], from: h(7, 0), to: h(9, 30), note: 'Platform defect' },
      { kind: 'trainDelay', train: 'LC-U-0750', stopIndex: 1, minutes: 6, note: 'Passenger taken ill' },
    ],
    actual: [
      { kind: 'trainDelay', train: 'IC-D-0800', stopIndex: 0, minutes: 14 },
      { kind: 'speedRestriction', segment: 'ELM-STB', extra: 6, from: h(7, 30), to: h(9, 30) },
      { kind: 'platformClosure', station: 'NGT', platforms: [1], from: h(7, 0), to: h(9, 30) },
      { kind: 'trainDelay', train: 'LC-U-0750', stopIndex: 1, minutes: 7 },
    ],
  },
];

/**
 * How the (synthetic) control room actually ran the railway on the observed days:
 * holding viable connections and replanning platforms. Replays use the same policy
 * so that prediction error reflects the model, not a mismatch in decisions.
 */
export const CONTROL_POLICY: Policy = { ...DEFAULT_POLICY, holdConnections: true, allowPlatformChange: true };

/** Noise used to synthesise observed days: small, always-positive running and dwell overruns. */
export const OBSERVED_NOISE = { runTimeMean: 0.35, dwellMean: 0.3 };

export function buildScenario(spec: ScenarioSpec, observed?: ObservedStopTime[]): Scenario {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    network: sampleNetwork,
    timetable: buildSampleTimetable(),
    incidents: spec.incidents,
    observed,
  };
}

const observed = observedData as Record<string, ObservedStopTime[]>;

export const builtInScenarios: Scenario[] = scenarioSpecs.map((s) => buildScenario(s, observed[s.id]));

export function getBuiltInScenario(id: string): Scenario | undefined {
  return builtInScenarios.find((s) => s.id === id);
}
