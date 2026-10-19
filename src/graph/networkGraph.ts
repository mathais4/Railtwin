import type { Network, Segment, Station } from '../model/types.ts';
import { MinHeap } from '../util/heap.ts';

export interface SegStep {
  seg: Segment;
  /** 0 = travelling from seg.from to seg.to, 1 = the reverse. */
  dir: 0 | 1;
  from: string;
  to: string;
}

export interface Path {
  steps: SegStep[];
  time: number;
}

/**
 * Undirected multigraph over stations, weighted by minimum running time.
 * Provides shortest paths (Dijkstra) with optional avoided segments, used both
 * for routing trains between calling points and for evaluating reroutes.
 */
export class NetworkGraph {
  readonly stations = new Map<string, Station>();
  readonly segments = new Map<string, Segment>();
  private readonly adj = new Map<string, { seg: Segment; to: string; dir: 0 | 1 }[]>();

  readonly network: Network;

  constructor(network: Network) {
    this.network = network;
    for (const s of network.stations) {
      if (this.stations.has(s.id)) throw new Error(`Duplicate station id ${s.id}`);
      this.stations.set(s.id, s);
      this.adj.set(s.id, []);
    }
    for (const seg of network.segments) {
      if (this.segments.has(seg.id)) throw new Error(`Duplicate segment id ${seg.id}`);
      if (!this.stations.has(seg.from) || !this.stations.has(seg.to)) {
        throw new Error(`Segment ${seg.id} references unknown station`);
      }
      if (seg.runTime <= 0) throw new Error(`Segment ${seg.id} must have positive runTime`);
      this.segments.set(seg.id, seg);
      this.adj.get(seg.from)!.push({ seg, to: seg.to, dir: 0 });
      this.adj.get(seg.to)!.push({ seg, to: seg.from, dir: 1 });
    }
  }

  station(id: string): Station {
    const s = this.stations.get(id);
    if (!s) throw new Error(`Unknown station ${id}`);
    return s;
  }

  neighbours(stationId: string) {
    return this.adj.get(stationId) ?? [];
  }

  /** Dijkstra from `from` to `to`, never using segments in `avoid`. */
  shortestPath(from: string, to: string, avoid: ReadonlySet<string> = new Set()): Path | null {
    if (from === to) return { steps: [], time: 0 };
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, { node: string; step: SegStep }>();
    const heap = new MinHeap<[number, string]>((a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]));
    heap.push([0, from]);
    while (heap.size) {
      const [d, u] = heap.pop()!;
      if (d > (dist.get(u) ?? Infinity)) continue;
      if (u === to) break;
      for (const e of this.neighbours(u)) {
        if (avoid.has(e.seg.id)) continue;
        const nd = d + e.seg.runTime;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, { node: u, step: { seg: e.seg, dir: e.dir, from: u, to: e.to } });
          heap.push([nd, e.to]);
        }
      }
    }
    if (!dist.has(to)) return null;
    const steps: SegStep[] = [];
    let cur = to;
    while (cur !== from) {
      const p = prev.get(cur)!;
      steps.push(p.step);
      cur = p.node;
    }
    steps.reverse();
    return { steps, time: dist.get(to)! };
  }

  /** Converts an explicit list of segment ids into oriented steps starting at `from`. */
  explicitPath(from: string, segmentIds: string[]): Path {
    const steps: SegStep[] = [];
    let cur = from;
    let time = 0;
    for (const id of segmentIds) {
      const seg = this.segments.get(id);
      if (!seg) throw new Error(`Unknown segment ${id}`);
      let dir: 0 | 1;
      if (seg.from === cur) dir = 0;
      else if (seg.to === cur) dir = 1;
      else throw new Error(`Segment ${id} does not touch ${cur}`);
      const next = dir === 0 ? seg.to : seg.from;
      steps.push({ seg, dir, from: cur, to: next });
      time += seg.runTime;
      cur = next;
    }
    return { steps, time };
  }

  /** Euclidean length of a segment in map units (used for drawing / distance axes). */
  segmentLength(seg: Segment): number {
    const a = this.station(seg.from);
    const b = this.station(seg.to);
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
