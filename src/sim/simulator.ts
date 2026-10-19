import type {
  Connection,
  ConnectionResult,
  KnockOnEdge,
  Movement,
  Policy,
  Scenario,
  Segment,
  SimOptions,
  SimResult,
  Station,
  StopResult,
  Train,
  TrainResult,
  WaitKind,
  WaitRecord,
} from '../model/types.ts';
import { DEFAULT_POLICY } from '../model/types.ts';
import { NetworkGraph, type SegStep } from '../graph/networkGraph.ts';
import { MinHeap } from '../util/heap.ts';
import { exponential, hashString, mulberry32 } from '../util/rng.ts';
import { computeKpis } from './metrics.ts';

/** Minutes before departure a train occupies its origin platform. */
export const ORIGIN_PREP = 5;
export const DEFAULT_MIN_DWELL = 1;
export const DEFAULT_TURNAROUND = 4;
const EPS = 1e-9;

// Train phases (plain constants rather than enums so the file runs under Node's type stripping).
const ARRIVING = 1; // wants a platform at ts.stop (possibly still occupying the approach segment)
const DWELLING = 2; // at a platform, wants to depart
const RUNNING = 3; // on a segment, not yet at its far end
const AT_SEG_END = 4; // at the far end of a segment, wants the next resource
const TERMINATING = 5; // arrived at destination, platform still occupied
const DONE = 6;

// Event types
const EV_START = 0;
const EV_ADVANCE = 1;
const EV_SEG_END = 2;
const EV_WAKE = 3;
const EV_TERMINATE = 4;

interface Ev {
  time: number;
  seq: number;
  type: number;
  train: number;
  token: number;
  key: string | null;
}

interface TrainState {
  idx: number;
  train: Train;
  prio: number;
  legs: SegStep[][];
  phase: number;
  stop: number;
  leg: number;
  step: number;
  onSegment: boolean;
  platform: number;
  arr: (number | null)[];
  dep: (number | null)[];
  plat: (number | null)[];
  token: number;
  waitKey: string | null;
  queuedAt: number;
  wait: { start: number; kind: WaitKind; blocker: number; where: string } | null;
  readyAt: number;
  enterTime: number;
  reachTime: number;
  directlyAffected: boolean;
  waitByKind: Partial<Record<WaitKind, number>>;
  rng: (() => number) | null;
}

interface SegState {
  seg: Segment;
  queues: [number[], number[]];
  lastEntry: [number, number];
  lastExit: [number, number];
  lastEntrant: [number, number];
  lastExiter: [number, number];
  intents: Map<number, { dir: 0 | 1; eta: number }>;
  restrictions: { extra: number; from: number; to: number }[];
  blockages: { from: number; to: number }[];
}

interface StationState {
  station: Station;
  occ: Int32Array;
  closures: { platforms: Set<number>; from: number; to: number }[];
}

interface ConnState {
  c: Connection;
  from: number;
  to: number;
  fromStop: number;
  toStop: number;
  /** true = always hold, false = never hold, null = follow policy */
  hold: boolean | null;
  maxHold: number;
  holdStart: number | null;
}

/**
 * Discrete-event simulation of a railway timetable.
 *
 * Resources are platforms (one train each), and segments (open line between
 * two stations). A segment carries any number of trains in one direction, kept
 * in order and separated by its headway; single-track segments additionally
 * exclude opposing movements. Trains hold the resource they are on until the
 * next one is granted, so congestion propagates backwards exactly as it does on
 * a real railway, and gridlock (deadlock) can be detected.
 *
 * The simulation is deterministic: the same scenario, policy and options always
 * produce the same result.
 */
export class Simulator {
  private readonly scenario: Scenario;
  private readonly policy: Policy;
  private readonly options: SimOptions;
  private readonly graph: NetworkGraph;
  private readonly trains: TrainState[] = [];
  private readonly trainIndex = new Map<string, number>();
  private readonly segs = new Map<string, SegState>();
  private readonly stations = new Map<string, StationState>();
  private readonly conns: ConnState[] = [];
  private readonly inbound = new Map<number, Map<number, ConnState[]>>();
  private readonly trainDelays = new Map<string, number>();
  private readonly platformOverride = new Map<string, number>();
  private readonly waiters = new Map<string, Set<number>>();
  /** Trains on a single-track section that have been promised a platform at its far end. */
  private readonly berths = new Map<string, Map<number, { platform: number; seg: string }>>();
  private readonly heap = new MinHeap<Ev>((a, b) => a.time < b.time || (a.time === b.time && a.seq < b.seq));
  private seq = 0;
  private now = 0;
  private events = 0;
  private readonly waits: WaitRecord[] = [];
  private readonly movements: Movement[] = [];
  private readonly lean: boolean;
  private readonly runTimeScale: number;
  private readonly extraDwell: number;

  constructor(scenario: Scenario, policy: Policy = DEFAULT_POLICY, options: SimOptions = {}) {
    this.scenario = scenario;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.options = options;
    this.lean = options.lean ?? false;
    this.runTimeScale = options.runTimeScale ?? 1;
    this.extraDwell = options.extraDwell ?? 0;
    this.graph = new NetworkGraph(scenario.network);
    this.setup();
  }

  // ------------------------------------------------------------------ setup

  private setup(): void {
    const { network, timetable, incidents } = this.scenario;

    for (const s of network.stations) {
      this.stations.set(s.id, { station: s, occ: new Int32Array(Math.max(1, s.platforms)).fill(-1), closures: [] });
    }
    for (const seg of network.segments) {
      this.segs.set(seg.id, {
        seg,
        queues: [[], []],
        lastEntry: [-Infinity, -Infinity],
        lastExit: [-Infinity, -Infinity],
        lastEntrant: [-1, -1],
        lastExiter: [-1, -1],
        intents: new Map(),
        restrictions: [],
        blockages: [],
      });
    }

    const boost = new Map<string, number>();
    const avoid = new Map<string, Set<string>>();
    const holdOverride = new Map<string, { hold: boolean; maxHold?: number }>();
    for (const iv of this.policy.interventions) {
      switch (iv.kind) {
        case 'prioritise':
          boost.set(iv.train, (boost.get(iv.train) ?? 0) + (iv.boost ?? 10));
          break;
        case 'reroute': {
          const set = avoid.get(iv.train) ?? new Set<string>();
          iv.avoid.forEach((s) => set.add(s));
          avoid.set(iv.train, set);
          break;
        }
        case 'hold':
          holdOverride.set(iv.connection, { hold: true, maxHold: iv.maxHold });
          break;
        case 'release':
          holdOverride.set(iv.connection, { hold: false });
          break;
        case 'platform':
          this.platformOverride.set(`${iv.train}:${iv.stopIndex}`, iv.platform);
          break;
      }
    }

    timetable.trains.forEach((train, idx) => {
      if (this.trainIndex.has(train.id)) throw new Error(`Duplicate train id ${train.id}`);
      if (train.stops.length < 2) throw new Error(`Train ${train.id} needs at least two stops`);
      if (train.stops[0].dep === undefined) throw new Error(`Train ${train.id} has no origin departure`);
      this.trainIndex.set(train.id, idx);
      const legs: SegStep[][] = [];
      const av = avoid.get(train.id);
      for (let i = 0; i + 1 < train.stops.length; i++) {
        const a = train.stops[i].station;
        const b = train.stops[i + 1].station;
        let path = train.route?.[i] ? this.graph.explicitPath(a, train.route[i]) : this.graph.shortestPath(a, b);
        if (path && av && path.steps.some((s) => av.has(s.seg.id))) {
          const alt = this.graph.shortestPath(a, b, av);
          if (alt) path = alt;
        }
        if (!path || path.steps.length === 0) throw new Error(`No route for ${train.id} from ${a} to ${b}`);
        if (path.steps[path.steps.length - 1].to !== b) throw new Error(`Route for ${train.id} does not reach ${b}`);
        legs.push(path.steps);
      }
      const n = train.stops.length;
      this.trains.push({
        idx,
        train,
        prio: train.priority + (boost.get(train.id) ?? 0),
        legs,
        phase: 0,
        stop: 0,
        leg: 0,
        step: 0,
        onSegment: false,
        platform: -1,
        arr: new Array(n).fill(null),
        dep: new Array(n).fill(null),
        plat: new Array(n).fill(null),
        token: 0,
        waitKey: null,
        queuedAt: -1,
        wait: null,
        readyAt: 0,
        enterTime: 0,
        reachTime: 0,
        directlyAffected: false,
        waitByKind: {},
        rng: this.options.noise ? mulberry32(this.options.noise.seed ^ hashString(train.id)) : null,
      });
    });

    for (const iv of this.policy.interventions) {
      if ((iv.kind === 'prioritise' || iv.kind === 'reroute' || iv.kind === 'platform') && !this.trainIndex.has(iv.train)) {
        throw new Error(`Intervention references unknown train ${iv.train}`);
      }
    }

    for (const c of timetable.connections) {
      const from = this.trainIndex.get(c.fromTrain);
      const to = this.trainIndex.get(c.toTrain);
      if (from === undefined || to === undefined) throw new Error(`Connection ${c.id} references unknown train`);
      const fromStop = this.trains[from].train.stops.findIndex((s, i) => i > 0 && s.station === c.station);
      const toStop = this.trains[to].train.stops.findIndex((s, i) => i < this.trains[to].train.stops.length - 1 && s.station === c.station);
      if (fromStop < 0 || toStop < 0) throw new Error(`Connection ${c.id}: trains do not both call at ${c.station}`);
      const ov = holdOverride.get(c.id);
      const cs: ConnState = {
        c,
        from,
        to,
        fromStop,
        toStop,
        hold: ov ? ov.hold : null,
        maxHold: ov?.maxHold ?? c.maxHold,
        holdStart: null,
      };
      this.conns.push(cs);
      let byStop = this.inbound.get(to);
      if (!byStop) this.inbound.set(to, (byStop = new Map()));
      const list = byStop.get(toStop) ?? [];
      list.push(cs);
      byStop.set(toStop, list);
    }

    for (const inc of incidents) {
      switch (inc.kind) {
        case 'trainDelay': {
          const idx = this.trainIndex.get(inc.train);
          if (idx === undefined) throw new Error(`Incident references unknown train ${inc.train}`);
          const key = `${idx}:${inc.stopIndex}`;
          this.trainDelays.set(key, (this.trainDelays.get(key) ?? 0) + inc.minutes);
          break;
        }
        case 'speedRestriction':
          this.seg(inc.segment).restrictions.push({ extra: inc.extra, from: inc.from, to: inc.to });
          break;
        case 'blockage':
          this.seg(inc.segment).blockages.push({ from: inc.from, to: inc.to });
          break;
        case 'platformClosure': {
          const st = this.stations.get(inc.station);
          if (!st) throw new Error(`Incident references unknown station ${inc.station}`);
          st.closures.push({ platforms: new Set(inc.platforms.map((p) => p - 1)), from: inc.from, to: inc.to });
          break;
        }
      }
    }
  }

  private seg(id: string): SegState {
    const s = this.segs.get(id);
    if (!s) throw new Error(`Unknown segment ${id}`);
    return s;
  }

  // ------------------------------------------------------------------ event plumbing

  private push(time: number, type: number, train: number, token = 0, key: string | null = null): void {
    this.heap.push({ time, seq: this.seq++, type, train, token, key });
  }

  private notify(key: string): void {
    const w = this.waiters.get(key);
    if (w && w.size > 0) this.push(this.now, EV_WAKE, -1, 0, key);
  }

  /** Park a train until `key` is notified and/or until time `until`. */
  private waitFor(
    ts: TrainState,
    kind: WaitKind | null,
    opts: { key?: string; until?: number; blocker?: number; where: string },
  ): void {
    ts.token++;
    if (opts.key) {
      let set = this.waiters.get(opts.key);
      if (!set) this.waiters.set(opts.key, (set = new Set()));
      set.add(ts.idx);
      ts.waitKey = opts.key;
    }
    if (opts.until !== undefined && Number.isFinite(opts.until)) {
      this.push(Math.max(opts.until, this.now + 1e-6), EV_ADVANCE, ts.idx, ts.token);
    }
    if (ts.queuedAt < 0) ts.queuedAt = this.now;
    if (kind) {
      if (ts.wait && (ts.wait.kind !== kind || ts.wait.where !== opts.where)) this.closeWait(ts, true);
      if (!ts.wait) ts.wait = { start: this.now, kind, blocker: opts.blocker ?? -1, where: opts.where };
      else ts.wait.blocker = opts.blocker ?? ts.wait.blocker;
    } else if (ts.wait) {
      this.closeWait(ts, true);
    }
  }

  private unpark(ts: TrainState): void {
    if (ts.waitKey) {
      this.waiters.get(ts.waitKey)?.delete(ts.idx);
      ts.waitKey = null;
    }
    ts.token++;
  }

  private closeWait(ts: TrainState, keepQueue = false): void {
    const w = ts.wait;
    if (w) {
      const dur = this.now - w.start;
      if (dur > EPS) {
        ts.waitByKind[w.kind] = (ts.waitByKind[w.kind] ?? 0) + dur;
        if (!this.lean) {
          this.waits.push({
            train: ts.train.id,
            kind: w.kind,
            blocker: w.blocker >= 0 ? this.trains[w.blocker].train.id : null,
            where: w.where,
            start: w.start,
            end: this.now,
          });
        }
      }
      ts.wait = null;
    }
    if (!keepQueue) ts.queuedAt = -1;
  }

  private advance(ts: TrainState): void {
    this.unpark(ts);
    switch (ts.phase) {
      case ARRIVING:
        this.tryArrive(ts);
        break;
      case DWELLING:
        this.tryDepart(ts);
        break;
      case AT_SEG_END:
        this.tryLeaveSegment(ts);
        break;
      default:
        break;
    }
  }

  private dispatchOrder(a: TrainState, b: TrainState): number {
    switch (this.policy.dispatch) {
      case 'priority':
        return b.prio - a.prio || a.queuedAt - b.queuedAt || a.idx - b.idx;
      case 'schedule': {
        const sa = a.train.stops[a.stop].dep ?? a.train.stops[a.stop].arr ?? 0;
        const sb = b.train.stops[b.stop].dep ?? b.train.stops[b.stop].arr ?? 0;
        return sa - sb || a.idx - b.idx;
      }
      default:
        return a.queuedAt - b.queuedAt || a.idx - b.idx;
    }
  }

  // ------------------------------------------------------------------ platforms

  private closureEnd(st: StationState, p: number): number | null {
    let end: number | null = null;
    for (const c of st.closures) {
      if (c.platforms.has(p) && this.now >= c.from && this.now < c.to) end = Math.max(end ?? -Infinity, c.to);
    }
    return end;
  }

  private platformFree(st: StationState, p: number): boolean {
    return st.occ[p] === -1 && this.closureEnd(st, p) === null;
  }

  private releasePlatform(ts: TrainState): void {
    const stationId = ts.train.stops[ts.stop].station;
    const st = this.stations.get(stationId)!;
    const freed = ts.platform;
    if (freed >= 0 && st.occ[freed] === ts.idx) st.occ[freed] = -1;
    ts.platform = -1;
    // Flexible arrivals wait on the station; fixed-platform arrivals on their own platform,
    // so freeing one platform doesn't wake every train queued for the station.
    this.notify(`p:${stationId}`);
    if (freed >= 0) this.notify(`p:${stationId}:${freed}`);
  }

  private tryArrive(ts: TrainState): void {
    const stop = ts.train.stops[ts.stop];
    const stationId = stop.station;
    const st = this.stations.get(stationId)!;
    const n = st.occ.length;
    let planned = (this.platformOverride.get(`${ts.train.id}:${ts.stop}`) ?? stop.platform ?? 1) - 1;
    if (planned < 0 || planned >= n) planned = 0;
    const flexible = this.policy.allowPlatformChange;

    // Trains already on a single line into this station have been promised a platform. A train
    // that will itself leave over one of those single lines must not take that platform, or the
    // two would wait for each other forever.
    const promised = this.berths.get(stationId);
    const hasBerth = promised?.has(ts.idx) ?? false;
    const nextSeg = this.nextSegment(ts);
    const conflicting: number[] = [];
    if (promised && !hasBerth && nextSeg) {
      for (const [t, b] of promised) if (t !== ts.idx && b.seg === nextSeg) conflicting.push(b.platform);
    }
    const usable = (p: number) => {
      if (!this.platformFree(st, p)) return false;
      if (conflicting.length === 0) return true;
      if (flexible) {
        let free = 0;
        for (let q = 0; q < n; q++) if (this.platformFree(st, q)) free++;
        return free - conflicting.length >= 1;
      }
      return !conflicting.includes(p);
    };

    let chosen = -1;
    if (usable(planned)) chosen = planned;
    else if (flexible) {
      for (let p = 0; p < n; p++) {
        if (usable(p)) {
          chosen = p;
          break;
        }
      }
    }

    if (chosen < 0) {
      let until: number | undefined;
      let closed = false;
      const candidates = flexible ? [...Array(n).keys()] : [planned];
      for (const p of candidates) {
        const end = this.closureEnd(st, p);
        if (end !== null) {
          closed = closed || p === planned;
          if (st.occ[p] === -1) until = Math.min(until ?? Infinity, end);
        }
      }
      const occupiedByTrain = st.occ[planned] >= 0;
      const kind: WaitKind = !occupiedByTrain && closed ? 'platformClosed' : 'platform';
      if (kind === 'platformClosed') ts.directlyAffected = true;
      this.waitFor(ts, kind, { key: flexible ? `p:${stationId}` : `p:${stationId}:${planned}`, until, blocker: st.occ[planned], where: stationId });
      return;
    }

    st.occ[chosen] = ts.idx;
    ts.platform = chosen;
    ts.plat[ts.stop] = chosen + 1;
    this.berths.get(stationId)?.delete(ts.idx);
    if (ts.onSegment) this.exitSegment(ts);
    this.closeWait(ts);
    if (ts.stop > 0) ts.arr[ts.stop] = this.now;
    this.notify(`a:${ts.idx}:${ts.stop}`);

    const last = ts.train.stops.length - 1;
    if (ts.stop === last) {
      ts.phase = TERMINATING;
      this.push(this.now + (st.station.turnaround ?? DEFAULT_TURNAROUND), EV_TERMINATE, ts.idx);
      return;
    }

    let dwell = 0;
    if (ts.stop > 0) {
      dwell = (st.station.minDwell ?? DEFAULT_MIN_DWELL) + this.extraDwell;
      if (ts.rng && this.options.noise) dwell += exponential(ts.rng, this.options.noise.dwellMean);
    }
    const lateStart = this.trainDelays.get(`${ts.idx}:${ts.stop}`) ?? 0;
    if (lateStart > 0) ts.directlyAffected = true;
    const sched = stop.dep ?? this.now;
    ts.readyAt = Math.max(sched + lateStart, this.now + dwell);
    ts.phase = DWELLING;
    ts.leg = ts.stop;
    ts.step = 0;
    this.registerIntent(ts, ts.leg, 0, ts.readyAt);
    this.tryDepart(ts);
  }

  // ------------------------------------------------------------------ departures & segments

  private tryDepart(ts: TrainState): void {
    const stop = ts.train.stops[ts.stop];
    if (this.now < ts.readyAt - EPS) {
      this.waitFor(ts, null, { until: ts.readyAt, where: stop.station });
      return;
    }

    const conns = this.inbound.get(ts.idx)?.get(ts.stop);
    if (conns) {
      for (const cs of conns) {
        const hold = cs.hold ?? this.policy.holdConnections;
        if (!hold) continue;
        const limit = (stop.dep ?? this.now) + cs.maxHold;
        const fa = this.trains[cs.from].arr[cs.fromStop];
        if (fa !== null) {
          const need = fa + cs.c.minTransfer;
          if (this.now < need - EPS && need <= limit + EPS) {
            cs.holdStart ??= this.now;
            this.waitFor(ts, 'connection', { until: need, blocker: cs.from, where: stop.station });
            return;
          }
        } else if (this.now < limit - EPS && this.feederEta(cs) + cs.c.minTransfer <= limit + EPS) {
          // Only hold while the feeder is still forecast to make it; re-check every minute.
          cs.holdStart ??= this.now;
          this.waitFor(ts, 'connection', {
            key: `a:${cs.from}:${cs.fromStop}`,
            until: Math.min(limit, this.now + 1),
            blocker: cs.from,
            where: stop.station,
          });
          return;
        }
      }
    }

    const step = ts.legs[ts.leg][0];
    if (!this.canEnter(ts, step, true)) return;
    this.releasePlatform(ts);
    ts.dep[ts.stop] = this.now;
    this.closeWait(ts);
    this.enter(ts, ts.leg, 0);
  }

  private plannedPlatform(ts: TrainState, stopIdx: number, stationId: string): number {
    const n = this.stations.get(stationId)!.occ.length;
    const p = (this.platformOverride.get(`${ts.train.id}:${stopIdx}`) ?? ts.train.stops[stopIdx]?.platform ?? 1) - 1;
    return p >= 0 && p < n ? p : 0;
  }

  private needsBerth(ts: TrainState, step: SegStep): boolean {
    const legSteps = ts.legs[ts.leg];
    return ts.train.stops[ts.leg + 1]?.station === step.to && legSteps[legSteps.length - 1] === step;
  }

  /** The segment a train at a station will leave on next, or null if it terminates here. */
  private nextSegment(ts: TrainState): string | null {
    if (ts.stop >= ts.train.stops.length - 1) return null;
    return ts.legs[ts.stop]?.[0]?.seg.id ?? null;
  }

  /** Could this platform be cleared without first using single line `seg`? */
  private clearsWithout(occupant: number, seg: string): boolean {
    const o = this.trains[occupant];
    return this.nextSegment(o) !== seg;
  }

  /**
   * May a train start along single line `seg` towards `stationId`? Only if a
   * platform there is free, or held by a train that can leave without needing
   * this same line, once platforms already promised to other trains are counted.
   */
  private berthAvailable(stationId: string, planned: number, self: number, seg: string): boolean {
    const st = this.stations.get(stationId)!;
    const promised = this.berths.get(stationId);
    const ok = (p: number) => {
      if (this.closureEnd(st, p) !== null) return false;
      const occ = st.occ[p];
      return occ === -1 || (occ !== self && this.clearsWithout(occ, seg));
    };
    if (this.policy.allowPlatformChange) {
      let avail = 0;
      for (let p = 0; p < st.occ.length; p++) if (ok(p)) avail++;
      let reserved = 0;
      if (promised) for (const [t] of promised) if (t !== self) reserved++;
      return avail - reserved >= 1;
    }
    if (!ok(planned)) return false;
    if (promised) for (const [t, b] of promised) if (t !== self && b.platform === planned && b.seg !== seg) return false;
    return true;
  }

  /**
   * Forecast arrival of a feeder train at the interchange, as a control system
   * would make it: scheduled arrival plus the delay at its last departure (no
   * credit for recovery), or the time it would reach the end of its current
   * segment if that is later.
   */
  private feederEta(cs: ConnState): number {
    const f = this.trains[cs.from];
    const stops = f.train.stops;
    let delay = 0;
    let lastDep = -1;
    for (let k = cs.fromStop - 1; k >= 0; k--) {
      if (f.dep[k] !== null) {
        delay = f.dep[k]! - stops[k].dep!;
        lastDep = k;
        break;
      }
    }
    if (lastDep < 0) delay = Math.max(0, this.now - stops[0].dep!, f.readyAt - stops[0].dep!);
    let eta = stops[cs.fromStop].arr! + Math.max(0, delay);
    if (f.onSegment && f.leg === cs.fromStop - 1 && f.step === f.legs[f.leg].length - 1) eta = Math.max(eta, f.reachTime);
    return Math.max(eta, this.now);
  }

  private hasSpareStationCapacity(stationId: string, own: number): boolean {
    const st = this.stations.get(stationId)!;
    for (let p = 0; p < st.occ.length; p++) {
      if (p !== own && this.platformFree(st, p)) return true;
    }
    return false;
  }

  /** Checks whether `ts` may enter `step` now; if not, parks it with the reason. */
  private canEnter(ts: TrainState, step: SegStep, fromStation: boolean): boolean {
    const ss = this.seg(step.seg.id);
    const seg = ss.seg;
    const d = step.dir;
    const where = seg.id;

    for (const b of ss.blockages) {
      if (this.now >= b.from && this.now < b.to) {
        ts.directlyAffected = true;
        this.waitFor(ts, 'blockage', { until: b.to, where });
        return false;
      }
    }
    // Interlocking rule: never let a train onto a single line unless it has a platform waiting at
    // the far end. Without it, trains can fill a passing loop and lock the line solid.
    const berthNeeded = seg.tracks === 1 && this.needsBerth(ts, step);
    if (berthNeeded) {
      const planned = this.plannedPlatform(ts, ts.leg + 1, step.to);
      if (!this.berthAvailable(step.to, planned, ts.idx, seg.id)) {
        const st = this.stations.get(step.to)!;
        const key = this.policy.allowPlatformChange ? `p:${step.to}` : `p:${step.to}:${planned}`;
        this.waitFor(ts, 'platform', { key, blocker: st.occ[planned], where: step.to });
        return false;
      }
    }
    if (seg.tracks === 1 && ss.queues[1 - d].length > 0) {
      this.waitFor(ts, 'singleTrack', { key: `s:${seg.id}`, blocker: ss.queues[1 - d][0], where });
      return false;
    }
    const h = ss.lastEntry[d] + seg.headway;
    if (this.now < h - EPS) {
      this.waitFor(ts, 'headway', { until: h, blocker: ss.lastEntrant[d], where });
      return false;
    }

    if (this.policy.dispatch === 'priority' && fromStation && ss.intents.size > 0) {
      const look = this.policy.lookahead;
      const here = ts.train.stops[ts.stop].station;
      for (const [u, it] of ss.intents) {
        if (u === ts.idx) continue;
        const other = this.trains[u];
        if (other.prio <= ts.prio || other.phase === DONE) continue;
        if (it.eta > this.now + look || it.eta + look <= this.now + EPS) continue;
        if (seg.tracks === 2 && it.dir !== d) continue;
        // Never yield on single track unless the oncoming train can actually get into this station.
        if (it.dir !== d && !this.hasSpareStationCapacity(here, ts.platform)) continue;
        this.waitFor(ts, 'yield', { key: `s:${seg.id}`, until: Math.max(it.eta, this.now) + look, blocker: u, where });
        return false;
      }
    }
    return true;
  }

  private registerIntent(ts: TrainState, leg: number, step: number, eta: number): void {
    if (this.policy.dispatch !== 'priority') return;
    const s = ts.legs[leg]?.[step];
    if (s) this.seg(s.seg.id).intents.set(ts.idx, { dir: s.dir, eta });
  }

  private enter(ts: TrainState, leg: number, step: number): void {
    const s = ts.legs[leg][step];
    const ss = this.seg(s.seg.id);
    const d = s.dir;
    ss.queues[d].push(ts.idx);
    ss.lastEntry[d] = this.now;
    ss.lastEntrant[d] = ts.idx;
    ss.intents.delete(ts.idx);
    if (ss.seg.tracks === 1 && step === ts.legs[leg].length - 1) {
      let b = this.berths.get(s.to);
      if (!b) this.berths.set(s.to, (b = new Map()));
      b.set(ts.idx, { platform: this.plannedPlatform(ts, leg + 1, s.to), seg: ss.seg.id });
    }
    ts.leg = leg;
    ts.step = step;
    ts.onSegment = true;
    ts.phase = RUNNING;
    ts.enterTime = this.now;

    let rt = ss.seg.runTime * (ts.train.runTimeFactor ?? 1) * this.runTimeScale;
    for (const r of ss.restrictions) {
      if (this.now >= r.from && this.now < r.to) {
        rt += r.extra;
        ts.directlyAffected = true;
      }
    }
    if (ts.rng && this.options.noise) rt += exponential(ts.rng, this.options.noise.runTimeMean);
    ts.reachTime = this.now + rt;
    this.push(ts.reachTime, EV_SEG_END, ts.idx);
    this.registerIntent(ts, leg, step + 1, ts.reachTime);
    this.notify(`s:${ss.seg.id}`);
  }

  private exitSegment(ts: TrainState): void {
    const s = ts.legs[ts.leg][ts.step];
    const ss = this.seg(s.seg.id);
    const d = s.dir;
    const q = ss.queues[d];
    if (q[0] === ts.idx) q.shift();
    else {
      const i = q.indexOf(ts.idx);
      if (i >= 0) q.splice(i, 1);
    }
    ss.lastExit[d] = this.now;
    ss.lastExiter[d] = ts.idx;
    ts.onSegment = false;
    if (!this.lean) {
      this.movements.push({
        train: ts.train.id,
        segment: ss.seg.id,
        dir: d,
        enter: ts.enterTime,
        reach: ts.reachTime,
        exit: this.now,
      });
    }
    this.notify(`s:${ss.seg.id}`);
    this.notify(`x:${ss.seg.id}:${d}`);
  }

  private tryLeaveSegment(ts: TrainState): void {
    const steps = ts.legs[ts.leg];
    const s = steps[ts.step];
    const ss = this.seg(s.seg.id);
    const d = s.dir;
    if (ss.queues[d][0] !== ts.idx) {
      this.waitFor(ts, 'following', { key: `x:${ss.seg.id}:${d}`, blocker: ss.queues[d][0], where: ss.seg.id });
      return;
    }
    const h = ss.lastExit[d] + ss.seg.headway;
    if (this.now < h - EPS) {
      this.waitFor(ts, 'headway', { until: h, blocker: ss.lastExiter[d], where: ss.seg.id });
      return;
    }
    if (ts.step + 1 < steps.length) {
      if (!this.canEnter(ts, steps[ts.step + 1], false)) return;
      const next = ts.step + 1;
      this.exitSegment(ts);
      this.closeWait(ts);
      this.enter(ts, ts.leg, next);
    } else {
      ts.stop = ts.leg + 1;
      ts.phase = ARRIVING;
      this.tryArrive(ts);
    }
  }

  // ------------------------------------------------------------------ main loop

  run(): SimResult {
    const t0 = performance.now();
    let lastSched = 0;
    for (const ts of this.trains) {
      const first = ts.train.stops[0].dep!;
      this.push(first - ORIGIN_PREP, EV_START, ts.idx);
      for (const s of ts.train.stops) lastSched = Math.max(lastSched, s.arr ?? 0, s.dep ?? 0);
    }
    const maxTime = this.options.maxTime ?? lastSched + 12 * 60;

    while (this.heap.size > 0) {
      const ev = this.heap.pop()!;
      if (ev.time > maxTime) break;
      this.now = ev.time;
      this.events++;
      switch (ev.type) {
        case EV_START: {
          const ts = this.trains[ev.train];
          ts.phase = ARRIVING;
          ts.stop = 0;
          this.tryArrive(ts);
          break;
        }
        case EV_ADVANCE: {
          const ts = this.trains[ev.train];
          if (ev.token === ts.token) this.advance(ts);
          break;
        }
        case EV_SEG_END: {
          const ts = this.trains[ev.train];
          if (ts.phase === RUNNING) {
            ts.phase = AT_SEG_END;
            this.advance(ts);
          }
          break;
        }
        case EV_WAKE: {
          const set = this.waiters.get(ev.key!);
          if (!set || set.size === 0) break;
          const list = [...set].map((i) => this.trains[i]).sort((a, b) => this.dispatchOrder(a, b));
          for (const ts of list) if (ts.waitKey === ev.key) this.advance(ts);
          break;
        }
        case EV_TERMINATE: {
          const ts = this.trains[ev.train];
          this.releasePlatform(ts);
          ts.phase = DONE;
          break;
        }
      }
    }
    return this.collect(performance.now() - t0);
  }

  // ------------------------------------------------------------------ results

  private collect(runtimeMs: number): SimResult {
    const trains: TrainResult[] = this.trains.map((ts) => {
      const stops: StopResult[] = ts.train.stops.map((s, i) => ({
        station: s.station,
        schedArr: s.arr ?? null,
        schedDep: s.dep ?? null,
        arr: ts.arr[i],
        dep: ts.dep[i],
        plannedPlatform: s.platform ?? null,
        platform: ts.plat[i],
        arrDelay: ts.arr[i] !== null && s.arr !== undefined ? ts.arr[i]! - s.arr : null,
        depDelay: ts.dep[i] !== null && s.dep !== undefined ? ts.dep[i]! - s.dep : null,
      }));
      const last = stops[stops.length - 1];
      return {
        id: ts.train.id,
        name: ts.train.name,
        kind: ts.train.kind,
        priority: ts.train.priority,
        passengers: ts.train.passengers,
        completed: ts.phase === DONE || ts.phase === TERMINATING,
        finalDelay: last.arrDelay,
        directlyAffected: ts.directlyAffected,
        waitByKind: ts.waitByKind,
        stops,
      };
    });

    const connections: ConnectionResult[] = this.conns.map((cs) => {
      const fa = this.trains[cs.from].arr[cs.fromStop];
      const td = this.trains[cs.to].dep[cs.toStop];
      const made = fa !== null && td !== null && td >= fa + cs.c.minTransfer - 1e-6;
      return {
        id: cs.c.id,
        station: cs.c.station,
        fromTrain: cs.c.fromTrain,
        toTrain: cs.c.toTrain,
        passengers: cs.c.passengers,
        made,
        heldMinutes: cs.holdStart !== null && td !== null ? Math.max(0, td - cs.holdStart) : 0,
      };
    });

    const edgeMap = new Map<string, KnockOnEdge>();
    for (const w of this.waits) {
      if (!w.blocker || w.blocker === w.train) continue;
      const k = `${w.blocker}>${w.train}`;
      const e = edgeMap.get(k) ?? { from: w.blocker, to: w.train, minutes: 0 };
      e.minutes += w.end - w.start;
      edgeMap.set(k, e);
    }
    const knockOn = [...edgeMap.values()].sort((a, b) => b.minutes - a.minutes);

    let deadlock: SimResult['deadlock'] = null;
    const stuck = this.trains.filter((t) => t.phase !== DONE && t.phase !== TERMINATING);
    if (stuck.length > 0) {
      deadlock = { stuck: stuck.map((t) => t.train.id), cycle: this.findCycle(stuck) };
    }

    const kpis = computeKpis(trains, connections, this.scenario.timetable.connections, {
      punctualityThreshold: this.options.punctualityThreshold,
      deadlocked: deadlock !== null,
      events: this.events,
    });

    return { trains, connections, waits: this.waits, movements: this.movements, knockOn, kpis, deadlock, runtimeMs };
  }

  /** Follows "waiting for" pointers from stuck trains to find a wait-for cycle. */
  private findCycle(stuck: TrainState[]): string[] {
    for (const start of stuck) {
      const seen = new Map<number, number>();
      const path: number[] = [];
      let cur = start.idx;
      while (cur >= 0 && !seen.has(cur)) {
        seen.set(cur, path.length);
        path.push(cur);
        cur = this.trains[cur].wait?.blocker ?? -1;
      }
      if (cur >= 0) return path.slice(seen.get(cur)).map((i) => this.trains[i].train.id);
    }
    return [];
  }
}

export function simulate(scenario: Scenario, policy: Policy = DEFAULT_POLICY, options: SimOptions = {}): SimResult {
  return new Simulator(scenario, policy, options).run();
}

/** Same timetable and network, with incidents removed. */
export function withoutIncidents(scenario: Scenario): Scenario {
  return { ...scenario, incidents: [] };
}
