import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The small slice of a SQL driver the repository needs. */
export interface SqlClient {
  readonly driver: 'pg' | 'psql';
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs `fn` inside one transaction; statements in it may not depend on each other's results. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/**
 * Connects using node-postgres when it is installed (the normal case). If it is
 * not, falls back to driving the `psql` CLI, which keeps the API and tests usable
 * on machines that have PostgreSQL but no npm access.
 */
export async function connect(url: string): Promise<SqlClient> {
  let mod: unknown;
  try {
    const name = 'pg'; // kept in a variable so bundlers and type-checkers treat it as optional
    mod = await import(name);
  } catch {
    if (!(await havePsql())) throw new Error('Install the "pg" package (npm install) or put psql on PATH');
    return new PsqlClient(url);
  }
  const pg = ((mod as { default?: unknown }).default ?? mod) as { Pool: new (cfg: object) => PgPool };
  return new PgClient(new pg.Pool({ connectionString: url, max: 5 }));
}

// ---------------------------------------------------------------- node-postgres

interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}
interface PgPool extends PgQueryable {
  connect(): Promise<PgQueryable & { release(): void }>;
  end(): Promise<void>;
}

class PgClient implements SqlClient {
  readonly driver = 'pg' as const;
  private readonly pool: PgPool;
  private readonly conn: PgQueryable | null;

  constructor(pool: PgPool, conn: PgQueryable | null = null) {
    this.pool = pool;
    this.conn = conn;
  }

  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    // An empty parameter list must go as undefined so multi-statement scripts use the simple protocol.
    const res = await (this.conn ?? this.pool).query(text, params.length ? params.map(toPgParam) : undefined);
    return res.rows as T[];
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const out = await fn(new PgClient(this.pool, c));
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

const toPgParam = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

// ---------------------------------------------------------------- psql fallback

/** Renders a parameter as a SQL literal. Only used by the psql fallback. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Cannot encode non-finite number');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.includes('\0')) throw new Error('NUL byte in parameter');
  return `'${s.replace(/'/g, "''")}'`;
}

export function interpolate(text: string, params: unknown[]): string {
  return text.replace(/\$(\d+)/g, (_, n) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`Missing parameter $${n}`);
    return sqlLiteral(params[i]);
  });
}

class PsqlClient implements SqlClient {
  readonly driver = 'psql' as const;
  private readonly url: string;
  private readonly buffer: string[] | null;

  constructor(url: string, buffer: string[] | null = null) {
    this.url = url;
    this.buffer = buffer;
  }

  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const sql = interpolate(text.trim().replace(/;\s*$/, ''), params);
    if (this.buffer) {
      this.buffer.push(sql + ';');
      return [];
    }
    const head = sql.slice(0, 12).toLowerCase();
    let wrapped: string;
    if (head.startsWith('with') && /\b(insert|update|delete)\b/i.test(sql)) {
      // Data-modifying CTEs must stay at top level, so read the result back as CSV instead.
      return parseCsv(await this.run(sql, false, true)) as T[];
    }
    if (head.startsWith('select') || head.startsWith('with')) {
      wrapped = `select coalesce(json_agg(t), '[]'::json) from (${sql}) t`;
    } else if (/\breturning\b/i.test(sql)) {
      wrapped = `with q as (${sql}) select coalesce(json_agg(q), '[]'::json) from q`;
    } else {
      await this.run(sql);
      return [];
    }
    const out = await this.run(wrapped);
    return JSON.parse(out.trim() || '[]') as T[];
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const buffer: string[] = [];
    const out = await fn(new PsqlClient(this.url, buffer));
    if (buffer.length) await this.run(buffer.join('\n'), true);
    return out;
  }

  private async run(sql: string, singleTransaction = false, csv = false): Promise<string> {
    const args = csv ? [this.url, '-X', '-q', '--csv', '-v', 'ON_ERROR_STOP=1'] : [this.url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
    if (singleTransaction) args.push('-1');
    // Pass SQL on stdin rather than argv so large batches don't hit argument-length limits.
    return new Promise((resolve, reject) => {
      const child = execFile('psql', [...args, '-f', '-'], { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      });
      child.stdin!.end(sql);
    });
  }

  async end(): Promise<void> {}
}

/** Minimal RFC 4180 CSV parser (header row → object keys). Empty unquoted fields become null. */
export function parseCsv(text: string): Record<string, string | null>[] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',' || ch === '\n') {
      row.push(field === '' && !wasQuoted ? null : field);
      field = '';
      wasQuoted = false;
      if (ch === '\n') {
        rows.push(row);
        row = [];
      }
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || wasQuoted || row.length) {
    row.push(field === '' && !wasQuoted ? null : field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h ?? '', r[i] ?? null])));
}

/** True if a `psql` binary is on PATH. */
export async function havePsql(): Promise<boolean> {
  try {
    await execFileAsync('psql', ['--version']);
    return true;
  } catch {
    return false;
  }
}
