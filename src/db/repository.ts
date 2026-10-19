import type { Incident, ObservedStopTime, Policy, Scenario, SimResult, Train } from '../model/types.ts';
import type { SqlClient } from './client.ts';

export const ENGINE_VERSION = '0.1.0';

/**
 * Persistence for networks, scenarios, observed days and simulation runs.
 * Bulk writes ship rows as one JSON document and expand them server-side with
 * jsonb_to_recordset, so saving a scenario is a handful of statements no matter
 * how many trains it has.
 */
export async function saveScenario(db: SqlClient, sc: Scenario): Promise<void> {
  const net = sc.network;
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into networks (id, name) values ($1, $2)
       on conflict (id) do update set name = excluded.name`,
      [net.id, net.name],
    );
    // Network rows are replaced wholesale; scenarios that share it keep referencing the id.
    await tx.query(`delete from segments where network_id = $1`, [net.id]);
    await tx.query(
      `insert into stations (network_id, id, name, platforms, x, y, min_dwell, turnaround, ord)
       select $1, r.id, r.name, r.platforms, r.x, r.y, r."minDwell", r.turnaround, r.ord
       from rows from (jsonb_to_recordset($2::jsonb) as (id text, name text, platforms int, x float8, y float8, "minDwell" float8, turnaround float8)) with ordinality as r(id, name, platforms, x, y, "minDwell", turnaround, ord)
       on conflict (network_id, id) do update set name = excluded.name, platforms = excluded.platforms,
         x = excluded.x, y = excluded.y, min_dwell = excluded.min_dwell, turnaround = excluded.turnaround, ord = excluded.ord`,
      [net.id, net.stations],
    );
    await tx.query(
      `insert into segments (network_id, id, from_station, to_station, run_time, tracks, headway, ord)
       select $1, r.id, r."from", r."to", r."runTime", r.tracks, r.headway, r.ord
       from rows from (jsonb_to_recordset($2::jsonb) as (id text, "from" text, "to" text, "runTime" float8, tracks int, headway float8)) with ordinality as r(id, "from", "to", "runTime", tracks, headway, ord)`,
      [net.id, net.segments],
    );
    await tx.query(
      `insert into scenarios (id, network_id, name, description, incidents)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (id) do update set network_id = excluded.network_id, name = excluded.name,
         description = excluded.description, incidents = excluded.incidents, updated_at = now()`,
      [sc.id, net.id, sc.name, sc.description, sc.incidents],
    );
    await tx.query(`delete from trains where scenario_id = $1`, [sc.id]);
    await tx.query(`delete from connections where scenario_id = $1`, [sc.id]);
    await tx.query(
      `insert into trains (scenario_id, id, name, kind, priority, passengers, run_time_factor, route)
       select $1, r.id, r.name, r.kind, r.priority, r.passengers, r."runTimeFactor", r.route
       from jsonb_to_recordset($2::jsonb) as r(id text, name text, kind text, priority int, passengers int, "runTimeFactor" float8, route jsonb)`,
      [sc.id, sc.timetable.trains.map(({ stops: _stops, ...t }) => t)],
    );
    const stops = sc.timetable.trains.flatMap((t) =>
      t.stops.map((s, seq) => ({ train: t.id, seq, station: s.station, arr: s.arr ?? null, dep: s.dep ?? null, platform: s.platform ?? null })),
    );
    await tx.query(
      `insert into train_stops (scenario_id, train_id, seq, station_id, sched_arr, sched_dep, platform)
       select $1, r.train, r.seq, r.station, r.arr, r.dep, r.platform
       from jsonb_to_recordset($2::jsonb) as r(train text, seq int, station text, arr float8, dep float8, platform int)`,
      [sc.id, stops],
    );
    await tx.query(
      `insert into connections (scenario_id, id, station_id, from_train, to_train, min_transfer, max_hold, passengers, miss_penalty, ord)
       select $1, r.id, r.station, r."fromTrain", r."toTrain", r."minTransfer", r."maxHold", r.passengers, r."missPenalty", r.ord
       from rows from (jsonb_to_recordset($2::jsonb) as (id text, station text, "fromTrain" text, "toTrain" text,
         "minTransfer" float8, "maxHold" float8, passengers int, "missPenalty" float8)) with ordinality as r(id, station, "fromTrain", "toTrain", "minTransfer", "maxHold", passengers, "missPenalty", ord)`,
      [sc.id, sc.timetable.connections],
    );
    if (sc.observed) await replaceObserved(tx, sc.id, sc.observed, 'synthetic');
  });
}

export async function replaceObserved(db: SqlClient, scenarioId: string, rows: ObservedStopTime[], source = 'import'): Promise<void> {
  await db.query(`delete from observed_stop_times where scenario_id = $1`, [scenarioId]);
  await db.query(
    `insert into observed_stop_times (scenario_id, train_id, seq, arr, dep, source)
     select $1, r.train, r.seq, r.arr, r.dep, $3
     from jsonb_to_recordset($2::jsonb) as r(train text, seq int, arr float8, dep float8)`,
    [scenarioId, rows, source],
  );
}

interface ScenarioRow { id: string; network_id: string; name: string; description: string; incidents: Incident[]; network_name: string }

export async function loadScenario(db: SqlClient, id: string): Promise<Scenario | null> {
  const [row] = await db.query<ScenarioRow>(
    `select s.id, s.network_id, s.name, s.description, s.incidents, n.name as network_name
     from scenarios s join networks n on n.id = s.network_id where s.id = $1`,
    [id],
  );
  if (!row) return null;
  const [stations, segments, trains, stops, connections, observed] = await Promise.all([
    db.query<Record<string, unknown>>(`select * from stations where network_id = $1 order by ord, id`, [row.network_id]),
    db.query<Record<string, unknown>>(`select * from segments where network_id = $1 order by ord, id`, [row.network_id]),
    db.query<Record<string, unknown>>(`select * from trains where scenario_id = $1 order by id`, [id]),
    db.query<Record<string, unknown>>(`select * from train_stops where scenario_id = $1 order by train_id, seq`, [id]),
    db.query<Record<string, unknown>>(`select * from connections where scenario_id = $1 order by ord, id`, [id]),
    db.query<Record<string, unknown>>(`select * from observed_stop_times where scenario_id = $1 order by train_id, seq`, [id]),
  ]);
  const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
  const stopsByTrain = new Map<string, Train['stops']>();
  for (const s of stops) {
    const list = stopsByTrain.get(String(s.train_id)) ?? [];
    list.push({ station: String(s.station_id), arr: num(s.sched_arr), dep: num(s.sched_dep), platform: num(s.platform) });
    stopsByTrain.set(String(s.train_id), list);
  }
  const trainList: Train[] = trains.map((t) => ({
    id: String(t.id),
    name: String(t.name),
    kind: String(t.kind),
    priority: Number(t.priority),
    passengers: Number(t.passengers),
    runTimeFactor: num(t.run_time_factor),
    route: (typeof t.route === 'string' ? JSON.parse(t.route) : t.route) ?? undefined,
    stops: stopsByTrain.get(String(t.id)) ?? [],
  }));
  // Keep timetable order stable: by first departure.
  trainList.sort((a, b) => (a.stops[0]?.dep ?? 0) - (b.stops[0]?.dep ?? 0) || a.id.localeCompare(b.id));
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    incidents: typeof row.incidents === 'string' ? JSON.parse(row.incidents) : row.incidents,
    network: {
      id: row.network_id,
      name: row.network_name,
      stations: stations.map((s) => ({
        id: String(s.id),
        name: String(s.name),
        platforms: Number(s.platforms),
        x: Number(s.x),
        y: Number(s.y),
        minDwell: num(s.min_dwell),
        turnaround: num(s.turnaround),
      })),
      segments: segments.map((s) => ({
        id: String(s.id),
        from: String(s.from_station),
        to: String(s.to_station),
        runTime: Number(s.run_time),
        tracks: Number(s.tracks) as 1 | 2,
        headway: Number(s.headway),
      })),
    },
    timetable: {
      trains: trainList,
      connections: connections.map((c) => ({
        id: String(c.id),
        station: String(c.station_id),
        fromTrain: String(c.from_train),
        toTrain: String(c.to_train),
        minTransfer: Number(c.min_transfer),
        maxHold: Number(c.max_hold),
        passengers: Number(c.passengers),
        missPenalty: num(c.miss_penalty),
      })),
    },
    observed: observed.length
      ? observed.map((o) => ({ train: String(o.train_id), seq: Number(o.seq), arr: num(o.arr), dep: num(o.dep) }))
      : undefined,
  };
}

export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
  trains: number;
  incidents: number;
  hasObserved: boolean;
}

export async function listScenarios(db: SqlClient): Promise<ScenarioSummary[]> {
  const rows = await db.query<Record<string, unknown>>(
    `select s.id, s.name, s.description, jsonb_array_length(s.incidents) as incidents,
            (select count(*) from trains t where t.scenario_id = s.id) as trains,
            exists (select 1 from observed_stop_times o where o.scenario_id = s.id) as has_observed
     from scenarios s order by s.created_at, s.id`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    description: String(r.description),
    trains: Number(r.trains),
    incidents: Number(r.incidents),
    hasObserved: Boolean(r.has_observed),
  }));
}

/** Stores a run and its per-stop outcomes in a single statement. Returns the run id. */
export async function saveRun(db: SqlClient, scenarioId: string, label: string, policy: Policy, result: SimResult): Promise<number> {
  const stops = result.trains.flatMap((t) =>
    t.stops.map((s, seq) => ({ train: t.id, seq, station: s.station, arr: s.arr, dep: s.dep, platform: s.platform, delay: s.arrDelay })),
  );
  const knock = result.knockOn.slice(0, 500);
  const [row] = await db.query<{ id: number | string }>(
    `with run as (
       insert into runs (scenario_id, label, policy, kpis, engine_version, runtime_ms)
       values ($1, $2, $3::jsonb, $4::jsonb, $5, $6) returning id
     ), st as (
       insert into run_stop_times (run_id, train_id, seq, station_id, arr, dep, platform, arr_delay)
       select run.id, r.train, r.seq, r.station, r.arr, r.dep, r.platform, r.delay
       from run, jsonb_to_recordset($7::jsonb) as r(train text, seq int, station text, arr float8, dep float8, platform int, delay float8)
       returning 1
     ), ko as (
       insert into run_knock_on (run_id, from_train, to_train, minutes)
       select run.id, r."from", r."to", r.minutes
       from run, jsonb_to_recordset($8::jsonb) as r("from" text, "to" text, minutes float8)
       returning 1
     )
     select id, (select count(*) from st) as stop_rows, (select count(*) from ko) as knock_rows from run`,
    [scenarioId, label, policy, result.kpis, ENGINE_VERSION, result.runtimeMs, stops, knock],
  );
  return Number(row.id);
}

export interface RunSummary {
  id: number;
  scenarioId: string;
  label: string;
  createdAt: string;
  kpis: SimResult['kpis'];
}

export async function listRuns(db: SqlClient, scenarioId?: string, limit = 50): Promise<RunSummary[]> {
  const rows = await db.query<Record<string, unknown>>(
    `select id, scenario_id, label, created_at, kpis from runs
     where ($1::text is null or scenario_id = $1) order by created_at desc, id desc limit $2`,
    [scenarioId ?? null, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    scenarioId: String(r.scenario_id),
    label: String(r.label),
    createdAt: String(r.created_at),
    kpis: typeof r.kpis === 'string' ? JSON.parse(r.kpis) : (r.kpis as SimResult['kpis']),
  }));
}

/** Trains with the most total arrival delay across every stored run of a scenario. */
export async function worstTrains(db: SqlClient, scenarioId: string, limit = 10) {
  return db.query<{ train_id: string; runs: number; avg_final_delay: number }>(
    `select st.train_id, count(distinct st.run_id)::int as runs, round(avg(st.arr_delay)::numeric, 2)::float8 as avg_final_delay
     from run_stop_times st join runs r on r.id = st.run_id
     where r.scenario_id = $1
       and st.seq = (select max(seq) from run_stop_times x where x.run_id = st.run_id and x.train_id = st.train_id)
     group by st.train_id order by avg_final_delay desc nulls last limit $2`,
    [scenarioId, limit],
  );
}
