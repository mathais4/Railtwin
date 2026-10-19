import type { Connection, Network, Stop, Train } from '../model/types.ts';
import { NetworkGraph } from '../graph/networkGraph.ts';
import { MinHeap } from '../util/heap.ts';
import { DEFAULT_TURNAROUND, ORIGIN_PREP } from '../sim/simulator.ts';

/** A repeating service, expanded into individual train runs. */
export interface ServicePattern {
  id: string;
  name: string;
  kind: string;
  priority: number;
  passengers: number;
  calls: string[];
  first: number;
  every: number;
  count: number;
  dwell?: number;
  /** Proportional recovery margin added to running time (default 6%). */
  padPct?: number;
  /** Fixed recovery margin per leg (default 0.5 min). */
  padMin?: number;
  runTimeFactor?: number;
  /** Segments to keep off when routing this service (its route is then fixed). */
  avoid?: string[];
}

const roundUpHalf = (x: number) => Math.ceil(x * 2 - 1e-9) / 2;

export function fmtTime(m: number): string {
  const h = Math.floor(m / 60);
  const mm = Math.round(m - h * 60);
  return `${String(h).padStart(2, '0')}${String(mm).padStart(2, '0')}`;
}

/** Expands service patterns into timed train runs with schedule padding. */
export function buildTrains(network: Network, patterns: ServicePattern[]): Train[] {
  const graph = new NetworkGraph(network);
  const trains: Train[] = [];
  for (const p of patterns) {
    const factor = p.runTimeFactor ?? 1;
    const avoid = new Set(p.avoid ?? []);
    const legs = p.calls.slice(0, -1).map((a, i) => {
      const path = graph.shortestPath(a, p.calls[i + 1], avoid);
      if (!path) throw new Error(`Pattern ${p.id}: no path ${a}→${p.calls[i + 1]}`);
      return path;
    });
    for (let k = 0; k < p.count; k++) {
      let t = p.first + k * p.every;
      const stops: Stop[] = [{ station: p.calls[0], dep: t }];
      legs.forEach((path, i) => {
        const run = roundUpHalf(path.time * factor * (1 + (p.padPct ?? 0.06)) + (p.padMin ?? 0.5));
        t += run;
        const isLast = i === legs.length - 1;
        const stop: Stop = { station: p.calls[i + 1], arr: t };
        if (!isLast) {
          t += p.dwell ?? 1;
          stop.dep = t;
        }
        stops.push(stop);
      });
      trains.push({
        id: `${p.id}-${fmtTime(p.first + k * p.every)}`,
        name: `${fmtTime(p.first + k * p.every)} ${p.name}`,
        kind: p.kind,
        priority: p.priority,
        passengers: p.passengers,
        stops,
        runTimeFactor: p.runTimeFactor,
        route: p.avoid ? legs.map((l) => l.steps.map((s) => s.seg.id)) : undefined,
      });
    }
  }
  return trains.sort((a, b) => a.stops[0].dep! - b.stops[0].dep! || a.id.localeCompare(b.id));
}

/**
 * Assigns platforms at every station by interval partitioning: occupations are
 * processed in start order and each takes the lowest-numbered platform free by
 * then (with a buffer). Throws if a station does not have enough platforms.
 */
export function assignPlatforms(network: Network, trains: Train[], buffer = 1): void {
  const occupations = new Map<string, { train: Train; stop: Stop; start: number; end: number }[]>();
  for (const train of trains) {
    train.stops.forEach((stop, i) => {
      const station = network.stations.find((s) => s.id === stop.station)!;
      const start = i === 0 ? stop.dep! - ORIGIN_PREP : stop.arr!;
      const end = i === train.stops.length - 1 ? stop.arr! + (station.turnaround ?? DEFAULT_TURNAROUND) : stop.dep!;
      const list = occupations.get(stop.station) ?? [];
      list.push({ train, stop, start, end: end + buffer });
      occupations.set(stop.station, list);
    });
  }
  for (const [stationId, list] of occupations) {
    const station = network.stations.find((s) => s.id === stationId)!;
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    // Free platforms ordered by number; busy ones in a heap keyed by when they free up.
    const busy = new MinHeap<[number, number]>((a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]));
    const free = new Set<number>(Array.from({ length: station.platforms }, (_, i) => i + 1));
    for (const occ of list) {
      while (busy.size && busy.peek()![0] <= occ.start) free.add(busy.pop()![1]);
      if (free.size === 0) {
        throw new Error(`Not enough platforms at ${station.name} for ${occ.train.id} at ${fmtTime(occ.start)}`);
      }
      const p = Math.min(...free);
      free.delete(p);
      occ.stop.platform = p;
      busy.push([occ.end, p]);
    }
  }
}

export interface ConnectionRule {
  station: string;
  fromKinds: string[];
  toKinds: string[];
  minTransfer: number;
  /** Longest planned wait that still counts as a connection. */
  window: number;
  maxHold: number;
  passengers: number;
  missPenalty?: number;
}

/** Finds planned connections: the first suitable outbound train after each feeder, per destination. */
export function findConnections(trains: Train[], rules: ConnectionRule[]): Connection[] {
  const out: Connection[] = [];
  for (const rule of rules) {
    for (const feeder of trains) {
      if (!rule.fromKinds.includes(feeder.kind)) continue;
      const fi = feeder.stops.findIndex((s, i) => i > 0 && s.station === rule.station);
      if (fi < 0) continue;
      const arr = feeder.stops[fi].arr!;
      const cameFrom = feeder.stops[fi - 1].station;
      const goesTo = feeder.stops[fi + 1]?.station;
      const seenDest = new Set<string>();
      const candidates = trains
        .filter((t) => t !== feeder && rule.toKinds.includes(t.kind))
        .map((t) => ({ t, i: t.stops.findIndex((s, i) => i < t.stops.length - 1 && s.station === rule.station) }))
        .filter(({ t, i }) => i >= 0 && t.stops[i].dep! - arr >= rule.minTransfer && t.stops[i].dep! - arr <= rule.window)
        .sort((a, b) => a.t.stops[a.i].dep! - b.t.stops[b.i].dep!);
      for (const { t, i } of candidates) {
        const next = t.stops[i + 1].station;
        if (next === cameFrom || next === goesTo || seenDest.has(next)) continue;
        seenDest.add(next);
        out.push({
          id: `${feeder.id}>${t.id}@${rule.station}`,
          station: rule.station,
          fromTrain: feeder.id,
          toTrain: t.id,
          minTransfer: rule.minTransfer,
          maxHold: rule.maxHold,
          passengers: rule.passengers,
          missPenalty: rule.missPenalty,
        });
      }
    }
  }
  return out;
}
