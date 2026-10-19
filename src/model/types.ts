/**
 * Core domain model. All times are minutes since 00:00 on the scenario day
 * (fractional minutes allowed), which keeps the arithmetic simple and exact
 * enough for operational modelling.
 */
export type Minutes = number;

export interface Station {
  id: string;
  name: string;
  /** Number of platform faces that can each hold one train. */
  platforms: number;
  /** Map coordinates (arbitrary units, used for visualisation and distance). */
  x: number;
  y: number;
  /** Minimum dwell for an intermediate stop (default 1 min). */
  minDwell?: Minutes;
  /** Time a terminating train keeps its platform after arrival (default 4 min). */
  turnaround?: Minutes;
}

export interface Segment {
  id: string;
  from: string;
  to: string;
  /** Minimum technical running time end-to-end. */
  runTime: Minutes;
  /** 1 = single track (one direction at a time), 2 = one track per direction. */
  tracks: 1 | 2;
  /** Minimum separation between successive trains entering or leaving in the same direction. */
  headway: Minutes;
}

export interface Network {
  id: string;
  name: string;
  stations: Station[];
  segments: Segment[];
}

export interface Stop {
  station: string;
  /** Scheduled arrival (absent at origin). */
  arr?: Minutes;
  /** Scheduled departure (absent at destination). */
  dep?: Minutes;
  /** Planned platform, 1-based. */
  platform?: number;
}

export interface Train {
  id: string;
  name: string;
  /** Free-form service type, e.g. "intercity", "local", "freight". */
  kind: string;
  /** Higher numbers are more important to the dispatcher. */
  priority: number;
  /** Passengers on board; used to weight delay minutes. */
  passengers: number;
  stops: Stop[];
  /** Multiplier on segment running time (e.g. 1.3 for slow freight). */
  runTimeFactor?: number;
  /** Optional explicit segment ids per leg; otherwise the fastest path is used. */
  route?: string[][];
}

export interface Connection {
  id: string;
  station: string;
  fromTrain: string;
  toTrain: string;
  /** Minimum interchange time. */
  minTransfer: Minutes;
  /** How long the outbound train may be held past its scheduled departure. */
  maxHold: Minutes;
  /** Passengers making this connection. */
  passengers: number;
  /** Extra delay a passenger suffers if the connection is missed (default 30). */
  missPenalty?: Minutes;
}

export interface Timetable {
  trains: Train[];
  connections: Connection[];
}

export type Incident =
  | { kind: 'trainDelay'; train: string; stopIndex: number; minutes: Minutes; note?: string }
  | { kind: 'speedRestriction'; segment: string; extra: Minutes; from: Minutes; to: Minutes; note?: string }
  | { kind: 'blockage'; segment: string; from: Minutes; to: Minutes; note?: string }
  | { kind: 'platformClosure'; station: string; platforms: number[]; from: Minutes; to: Minutes; note?: string };

export interface ObservedStopTime {
  train: string;
  seq: number;
  arr?: Minutes;
  dep?: Minutes;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  network: Network;
  timetable: Timetable;
  incidents: Incident[];
  observed?: ObservedStopTime[];
}

export type DispatchRule = 'fifo' | 'priority' | 'schedule';

export type Intervention =
  | { kind: 'hold'; connection: string; maxHold?: Minutes }
  | { kind: 'release'; connection: string }
  | { kind: 'prioritise'; train: string; boost?: number }
  | { kind: 'platform'; train: string; stopIndex: number; platform: number }
  | { kind: 'reroute'; train: string; avoid: string[] };

export interface Policy {
  /** Hold outbound trains for late feeders, up to each connection's maxHold. */
  holdConnections: boolean;
  /** Let trains use any free platform when their planned one is unavailable. */
  allowPlatformChange: boolean;
  /** How competing trains are ordered for a contested resource. */
  dispatch: DispatchRule;
  /** Minutes a lower-priority train will yield to an approaching higher-priority one (priority dispatch only). */
  lookahead: Minutes;
  interventions: Intervention[];
}

export const DEFAULT_POLICY: Policy = {
  holdConnections: false,
  allowPlatformChange: false,
  dispatch: 'fifo',
  lookahead: 4,
  interventions: [],
};

export interface SimOptions {
  /** Global multiplier on running times (used for calibration). */
  runTimeScale?: number;
  /** Extra minutes added to every intermediate dwell (used for calibration). */
  extraDwell?: Minutes;
  /** Random perturbation, used only to generate synthetic ground truth. */
  noise?: { seed: number; runTimeMean: Minutes; dwellMean: Minutes };
  /** Hard stop for the event loop. */
  maxTime?: Minutes;
  /** Arrival delay at or under which a train counts as punctual (default 5). */
  punctualityThreshold?: Minutes;
  /** Skip collecting movements/waits (faster for optimisation and benchmarks). */
  lean?: boolean;
}

// ---------- results ----------

export type WaitKind =
  | 'platform'
  | 'platformClosed'
  | 'singleTrack'
  | 'headway'
  | 'following'
  | 'blockage'
  | 'connection'
  | 'yield';

export interface WaitRecord {
  train: string;
  kind: WaitKind;
  /** Train that held the resource, when there was one. */
  blocker: string | null;
  where: string;
  start: Minutes;
  end: Minutes;
}

export interface Movement {
  train: string;
  segment: string;
  /** 0 = from→to, 1 = to→from */
  dir: 0 | 1;
  enter: Minutes;
  /** When the train reached the far end of the segment. */
  reach: Minutes;
  /** When it actually left the segment (later than reach if it was held at a signal). */
  exit: Minutes;
}

export interface StopResult {
  station: string;
  schedArr: Minutes | null;
  schedDep: Minutes | null;
  arr: Minutes | null;
  dep: Minutes | null;
  plannedPlatform: number | null;
  platform: number | null;
  arrDelay: Minutes | null;
  depDelay: Minutes | null;
}

export interface TrainResult {
  id: string;
  name: string;
  kind: string;
  priority: number;
  passengers: number;
  completed: boolean;
  /** Arrival delay at destination (null if the train never got there). */
  finalDelay: Minutes | null;
  /** True if an incident acted on this train directly (late start, restriction, blockage, closure). */
  directlyAffected: boolean;
  /** Minutes spent waiting, by cause. */
  waitByKind: Partial<Record<WaitKind, Minutes>>;
  stops: StopResult[];
}

export interface ConnectionResult {
  id: string;
  station: string;
  fromTrain: string;
  toTrain: string;
  passengers: number;
  made: boolean;
  /** Minutes the outbound train was held waiting for this feeder. */
  heldMinutes: Minutes;
}

export interface KnockOnEdge {
  from: string;
  to: string;
  minutes: Minutes;
}

export interface Kpis {
  trains: number;
  completed: number;
  punctualityPct: number;
  avgFinalDelay: Minutes;
  maxFinalDelay: Minutes;
  totalDelayMinutes: Minutes;
  delayedTrains: number;
  knockOnTrains: number;
  connectionsMade: number;
  connectionsMissed: number;
  passengerDelayMinutes: number;
  platformChanges: number;
  deadlocked: boolean;
  events: number;
}

export interface SimResult {
  trains: TrainResult[];
  connections: ConnectionResult[];
  waits: WaitRecord[];
  movements: Movement[];
  knockOn: KnockOnEdge[];
  kpis: Kpis;
  deadlock: { stuck: string[]; cycle: string[] } | null;
  runtimeMs: number;
}
