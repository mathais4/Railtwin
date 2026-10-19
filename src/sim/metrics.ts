import type { Connection, ConnectionResult, Kpis, SimResult, TrainResult } from '../model/types.ts';

export const DEFAULT_MISS_PENALTY = 30;
/** Delay charged per passenger on a train that never reaches its destination. */
export const STUCK_PENALTY = 120;
/** A train counts as a knock-on victim if it ends at least this late without being hit directly. */
export const KNOCK_ON_THRESHOLD = 3;

export function computeKpis(
  trains: TrainResult[],
  connections: ConnectionResult[],
  connectionDefs: Connection[],
  opts: { punctualityThreshold?: number; deadlocked: boolean; events: number },
): Kpis {
  const threshold = opts.punctualityThreshold ?? 5;
  const penalty = new Map(connectionDefs.map((c) => [c.id, c.missPenalty ?? DEFAULT_MISS_PENALTY]));

  let completed = 0;
  let punctual = 0;
  let total = 0;
  let max = 0;
  let delayed = 0;
  let knockOn = 0;
  let paxMinutes = 0;
  let platformChanges = 0;

  for (const t of trains) {
    const d = t.finalDelay;
    if (t.completed && d !== null) {
      completed++;
      const pos = Math.max(0, d);
      total += pos;
      max = Math.max(max, pos);
      if (d <= threshold) punctual++;
      else delayed++;
      if (!t.directlyAffected && d >= KNOCK_ON_THRESHOLD) knockOn++;
      paxMinutes += t.passengers * pos;
    } else {
      delayed++;
      if (!t.directlyAffected) knockOn++;
      paxMinutes += t.passengers * STUCK_PENALTY;
    }
    for (const s of t.stops) {
      if (s.plannedPlatform !== null && s.platform !== null && s.platform !== s.plannedPlatform) platformChanges++;
    }
  }

  let made = 0;
  let missed = 0;
  for (const c of connections) {
    if (c.made) made++;
    else {
      missed++;
      paxMinutes += c.passengers * (penalty.get(c.id) ?? DEFAULT_MISS_PENALTY);
    }
  }

  return {
    trains: trains.length,
    completed,
    punctualityPct: trains.length ? round((100 * punctual) / trains.length, 1) : 100,
    avgFinalDelay: completed ? round(total / completed, 2) : 0,
    maxFinalDelay: round(max, 1),
    totalDelayMinutes: round(total, 1),
    delayedTrains: delayed,
    knockOnTrains: knockOn,
    connectionsMade: made,
    connectionsMissed: missed,
    passengerDelayMinutes: Math.round(paxMinutes),
    platformChanges,
    deadlocked: opts.deadlocked,
    events: opts.events,
  };
}

export function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

export interface TrainImpact {
  id: string;
  name: string;
  baselineDelay: number | null;
  delay: number | null;
  /** Extra minutes of final delay compared with the undisrupted run. */
  impact: number | null;
  directlyAffected: boolean;
}

/** Per-train difference between a disrupted run and the undisrupted baseline. */
export function impactVsBaseline(result: SimResult, baseline: SimResult): TrainImpact[] {
  const base = new Map(baseline.trains.map((t) => [t.id, t]));
  return result.trains
    .map((t) => {
      const b = base.get(t.id);
      const bd = b?.finalDelay ?? null;
      return {
        id: t.id,
        name: t.name,
        baselineDelay: bd,
        delay: t.finalDelay,
        impact: t.finalDelay !== null && bd !== null ? round(t.finalDelay - bd, 2) : null,
        directlyAffected: t.directlyAffected,
      };
    })
    .sort((a, b) => (b.impact ?? Infinity) - (a.impact ?? Infinity));
}
