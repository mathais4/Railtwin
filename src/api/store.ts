import type { Policy, Scenario, SimResult } from '../model/types.ts';
import { builtInScenarios } from '../data/scenarios.ts';
import type { SqlClient } from '../db/client.ts';
import * as repo from '../db/repository.ts';

export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
  trains: number;
  incidents: number;
  hasObserved: boolean;
}

export interface StoredRun {
  id: number;
  scenarioId: string;
  label: string;
  createdAt: string;
  kpis: SimResult['kpis'];
}

/** Where scenarios come from and runs go. Postgres in production, memory for demos and tests. */
export interface Store {
  readonly kind: 'memory' | 'postgres';
  listScenarios(): Promise<ScenarioSummary[]>;
  getScenario(id: string): Promise<Scenario | null>;
  saveRun(scenarioId: string, label: string, policy: Policy, result: SimResult): Promise<number>;
  listRuns(scenarioId?: string): Promise<StoredRun[]>;
  close(): Promise<void>;
}

const summarise = (s: Scenario): ScenarioSummary => ({
  id: s.id,
  name: s.name,
  description: s.description,
  trains: s.timetable.trains.length,
  incidents: s.incidents.length,
  hasObserved: (s.observed?.length ?? 0) > 0,
});

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private readonly scenarios: Map<string, Scenario>;
  private readonly runs: StoredRun[] = [];

  constructor(scenarios: Scenario[] = builtInScenarios) {
    this.scenarios = new Map(scenarios.map((s) => [s.id, s]));
  }

  async listScenarios() {
    return [...this.scenarios.values()].map(summarise);
  }

  async getScenario(id: string) {
    return this.scenarios.get(id) ?? null;
  }

  async saveRun(scenarioId: string, label: string, _policy: Policy, result: SimResult) {
    const id = this.runs.length + 1;
    this.runs.unshift({ id, scenarioId, label, createdAt: new Date().toISOString(), kpis: result.kpis });
    if (this.runs.length > 500) this.runs.pop();
    return id;
  }

  async listRuns(scenarioId?: string) {
    return this.runs.filter((r) => !scenarioId || r.scenarioId === scenarioId).slice(0, 50);
  }

  async close() {}
}

export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  private readonly db: SqlClient;
  private readonly cache = new Map<string, Scenario>();

  constructor(db: SqlClient) {
    this.db = db;
  }

  listScenarios() {
    return repo.listScenarios(this.db);
  }

  async getScenario(id: string) {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const sc = await repo.loadScenario(this.db, id);
    if (sc) this.cache.set(id, sc);
    return sc;
  }

  saveRun(scenarioId: string, label: string, policy: Policy, result: SimResult) {
    return repo.saveRun(this.db, scenarioId, label, policy, result);
  }

  listRuns(scenarioId?: string) {
    return repo.listRuns(this.db, scenarioId);
  }

  close() {
    return this.db.end();
  }
}
