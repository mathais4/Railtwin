import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario } from '../model/types.ts';
import { simulate, withoutIncidents } from '../sim/simulator.ts';
import { compareResponses, PRESET_POLICIES, type NamedPolicy } from '../sim/strategies.ts';
import { optimise } from '../sim/optimiser.ts';
import { replay } from '../sim/replay.ts';
import { impactVsBaseline } from '../sim/metrics.ts';
import { CONTROL_POLICY } from '../data/scenarios.ts';
import { DEFAULT_POLICY } from '../model/types.ts';
import { MemoryStore, PostgresStore, type Store } from './store.ts';
import { BadRequest, parsePolicy } from './validate.ts';
import { connect } from '../db/client.ts';

const MAX_BODY = 256 * 1024;
const STATIC_DIR = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

class NotFound extends Error {
  readonly status = 404;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new BadRequest('body must be a JSON object');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

/** Drops bulky arrays the caller did not ask for. */
function slim<T extends { waits: unknown[]; movements: unknown[] }>(r: T, full: boolean) {
  return full ? r : { ...r, waits: undefined, movements: undefined };
}

export function createApp(store: Store): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const scenario = async (id: string): Promise<Scenario> => {
    const sc = await store.getScenario(decodeURIComponent(id));
    if (!sc) throw new NotFound(`scenario ${id} not found`);
    return sc;
  };

  type Handler = (m: RegExpMatchArray, req: IncomingMessage, url: URL) => Promise<unknown>;
  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/health$/, async () => ({ ok: true, store: store.kind })],
    ['GET', /^\/api\/scenarios$/, async () => store.listScenarios()],
    ['GET', /^\/api\/scenarios\/([^/]+)$/, async (m) => scenario(m[1])],
    ['GET', /^\/api\/policies$/, async () => PRESET_POLICIES],
    [
      'POST',
      /^\/api\/scenarios\/([^/]+)\/simulate$/,
      async (m, req) => {
        const sc = await scenario(m[1]);
        const body = await readJson(req);
        const policy = parsePolicy(body.policy);
        const result = simulate(sc, policy);
        const baseline = simulate(withoutIncidents(sc), DEFAULT_POLICY, { lean: true });
        const runId = body.save === false ? null : await store.saveRun(sc.id, String(body.label ?? 'api'), policy, result);
        return { runId, policy, result: slim(result, body.full === true), impact: impactVsBaseline(result, baseline) };
      },
    ],
    [
      'POST',
      /^\/api\/scenarios\/([^/]+)\/compare$/,
      async (m, req) => {
        const sc = await scenario(m[1]);
        const body = await readJson(req);
        let policies: NamedPolicy[] = PRESET_POLICIES;
        if (body.policies !== undefined) {
          if (!Array.isArray(body.policies) || body.policies.length === 0 || body.policies.length > 12) {
            throw new BadRequest('policies must be an array of 1–12 entries');
          }
          policies = body.policies.map((p: unknown, i: number) => {
            if (typeof p === 'string') {
              const preset = PRESET_POLICIES.find((x) => x.id === p);
              if (!preset) throw new BadRequest(`unknown preset ${p}`);
              return preset;
            }
            const o = (p ?? {}) as Record<string, unknown>;
            return { id: String(o.id ?? `custom-${i + 1}`), name: String(o.name ?? `Custom ${i + 1}`), description: '', policy: parsePolicy(o.policy) };
          });
        }
        const c = compareResponses(sc, policies);
        return {
          bestId: c.bestId,
          baseline: c.baseline.kpis,
          runs: c.runs.map((r) => ({ id: r.id, name: r.name, policy: r.policy, kpis: r.result.kpis, worstHit: r.impact.slice(0, 5) })),
        };
      },
    ],
    [
      'POST',
      /^\/api\/scenarios\/([^/]+)\/optimise$/,
      async (m, req) => {
        const sc = await scenario(m[1]);
        const body = await readJson(req);
        const maxEvaluations = body.maxEvaluations === undefined ? 300 : Number(body.maxEvaluations);
        if (!Number.isInteger(maxEvaluations) || maxEvaluations < 1 || maxEvaluations > 2000) throw new BadRequest('maxEvaluations must be 1–2000');
        const o = optimise(sc, parsePolicy(body.start), { maxEvaluations });
        const runId = await store.saveRun(sc.id, 'optimised', o.policy, o.result);
        return { runId, policy: o.policy, kpis: o.result.kpis, startCost: o.startCost, bestCost: o.bestCost, steps: o.steps, evaluations: o.evaluations, elapsedMs: o.elapsedMs };
      },
    ],
    [
      'GET',
      /^\/api\/scenarios\/([^/]+)\/replay$/,
      async (m, _req, url) => {
        const sc = await scenario(m[1]);
        if (!sc.observed?.length) throw new BadRequest('scenario has no observed data');
        const p = url.searchParams.get('policy');
        const policy = !p || p === 'control' ? CONTROL_POLICY : PRESET_POLICIES.find((x) => x.id === p)?.policy;
        if (!policy) throw new BadRequest(`unknown policy ${p}`);
        const r = replay(sc, policy);
        return { ...r, points: url.searchParams.get('points') === '1' ? r.points : undefined };
      },
    ],
    ['GET', /^\/api\/runs$/, async (_m, _req, url) => store.listRuns(url.searchParams.get('scenario') ?? undefined)],
  ];

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const [method, re, handler] of routes) {
          const m = url.pathname.match(re);
          if (!m) continue;
          if (req.method !== method) continue;
          return send(res, 200, await handler(m, req, url));
        }
        const known = routes.some(([, re]) => re.test(url.pathname));
        return send(res, known ? 405 : 404, { error: known ? 'method not allowed' : 'not found' });
      }
      return serveStatic(url.pathname, res);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 400 || status === 404) return send(res, status, { error: (err as Error).message });
      // Engine errors from bad references (unknown train in an intervention, etc.) are client errors too.
      if (err instanceof Error && /unknown|references|No route/i.test(err.message)) return send(res, 400, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'internal error' });
    }
  };
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(existsSync(STATIC_DIR) ? 'not found' : 'UI not built — run `npm run build:web`');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

export async function startServer(port = Number(process.env.PORT ?? 3000)): Promise<{ server: Server; store: Store }> {
  const url = process.env.DATABASE_URL;
  const store: Store = url ? new PostgresStore(await connect(url)) : new MemoryStore();
  const server = createServer(createApp(store));
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return { server, store };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, store } = await startServer();
  const addr = server.address();
  console.log(`RailTwin listening on http://localhost:${typeof addr === 'object' && addr ? addr.port : '?'} (store: ${store.kind})`);
  const shutdown = () => server.close(() => store.close().then(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
