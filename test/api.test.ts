import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createApp } from '../src/api/server.ts';
import { MemoryStore, PostgresStore, type Store } from '../src/api/store.ts';
import { parsePolicy } from '../src/api/validate.ts';
import { connect, interpolate, parseCsv } from '../src/db/client.ts';
import { loadScenario, saveScenario } from '../src/db/repository.ts';
import { builtInScenarios } from '../src/data/scenarios.ts';
import { simulate } from '../src/sim/simulator.ts';
import { migrate } from '../scripts/migrate.ts';
import { parseObservedCsv, parseTime } from '../src/cli.ts';

let server: Server;
let base: string;

before(async () => {
  server = createServer(createApp(new MemoryStore()));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}/api`;
});
after(() => server.close());

const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', body: JSON.stringify(body) });

test('API lists scenarios and simulates one', async () => {
  const list = await (await fetch(base + '/scenarios')).json();
  assert.equal(list.length, builtInScenarios.length);
  const res = await post('/scenarios/late-intercity/simulate', { policy: { holdConnections: true } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.policy.holdConnections, true);
  assert.equal(body.result.trains.length, 47);
  assert.equal(body.result.movements, undefined, 'bulky arrays are omitted unless full=true');
  const runs = await (await fetch(base + '/runs?scenario=late-intercity')).json();
  assert.equal(runs[0].id, body.runId);
});

test('API compare, optimise and replay', async () => {
  const cmp = await (await post('/scenarios/signal-failure/compare', { policies: ['timetable', 'hold'] })).json();
  assert.deepEqual(cmp.runs.map((r: { id: string }) => r.id), ['timetable', 'hold']);
  const opt = await (await post('/scenarios/signal-failure/optimise', { maxEvaluations: 60 })).json();
  assert.ok(opt.bestCost <= opt.startCost);
  const rep = await (await fetch(base + '/scenarios/signal-failure/replay')).json();
  assert.ok(rep.model.mae < rep.timetable.mae);
});

test('API rejects bad input with 400s and unknown things with 404s', async () => {
  assert.equal((await post('/scenarios/late-intercity/simulate', { policy: { dispatch: 'chaos' } })).status, 400);
  assert.equal((await post('/scenarios/late-intercity/simulate', { policy: { interventions: [{ kind: 'prioritise', train: 'NOPE' }] } })).status, 400);
  assert.equal((await fetch(base + '/scenarios/nope')).status, 404);
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/scenarios', { method: 'DELETE' })).status, 405);
  const bad = await fetch(base + '/scenarios/late-intercity/simulate', { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
});

test('policy validation fills defaults and rejects typos', () => {
  assert.equal(parsePolicy({}).dispatch, 'fifo');
  assert.throws(() => parsePolicy({ holdConection: true }), /not a known setting/);
  assert.throws(() => parsePolicy({ interventions: [{ kind: 'reroute', train: 'X', avoid: [] }] }), /avoid/);
});

test('psql fallback helpers quote safely and parse CSV', () => {
  assert.equal(interpolate('select $1, $2, $3', ["O'Brien", 4.5, null]), "select 'O''Brien', 4.5, NULL");
  assert.equal(interpolate('select $1::jsonb', [{ a: "x'y" }]), `select '{"a":"x''y"}'::jsonb`);
  assert.throws(() => interpolate('select $2', [1]), /Missing parameter/);
  assert.deepEqual(parseCsv('id,name\n1,"a, ""b"""\n2,\n'), [
    { id: '1', name: 'a, "b"' },
    { id: '2', name: null },
  ]);
});

test('observed CSV import parsing', () => {
  assert.equal(parseTime('07:42'), 462);
  assert.equal(parseTime('07:42:30'), 462.5);
  assert.equal(parseTime('462'), 462);
  assert.equal(parseTime(''), undefined);
  const rows = parseObservedCsv('train_id,seq,arr,dep\nIC-1,0,,07:00\nIC-1,1,07:09:30,07:11\n');
  assert.deepEqual(rows, [
    { train: 'IC-1', seq: 0, arr: undefined, dep: 420 },
    { train: 'IC-1', seq: 1, arr: 429.5, dep: 431 },
  ]);
});

// ------------------------------------------------------------ Postgres (runs when DATABASE_URL is set)

const dbUrl = process.env.DATABASE_URL;
test('Postgres round trip: a stored scenario simulates identically', { skip: !dbUrl && 'set DATABASE_URL to run' }, async () => {
  const db = await connect(dbUrl!);
  try {
    await migrate(db);
    const original = builtInScenarios[1];
    await saveScenario(db, original);
    const loaded = (await loadScenario(db, original.id))!;
    assert.ok(loaded);
    const a = simulate(original);
    const b = simulate(loaded);
    assert.deepEqual(b.kpis, { ...a.kpis });
    assert.deepEqual(b.trains, a.trains);
    assert.equal(loaded.observed?.length, original.observed?.length);

    const store: Store = new PostgresStore(db);
    const id = await store.saveRun(original.id, 'test', { holdConnections: false, allowPlatformChange: false, dispatch: 'fifo', lookahead: 4, interventions: [] }, a);
    const runs = await store.listRuns(original.id);
    assert.equal(runs[0].id, id);
    assert.deepEqual(runs[0].kpis.punctualityPct, a.kpis.punctualityPct);
    const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from run_stop_times where run_id = $1`, [id]);
    assert.equal(Number(n), a.trains.reduce((s, t) => s + t.stops.length, 0));
  } finally {
    await db.end();
  }
});
