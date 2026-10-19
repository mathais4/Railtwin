import type { Intervention, Policy } from '../model/types.ts';
import { DEFAULT_POLICY } from '../model/types.ts';

export class BadRequest extends Error {
  readonly status = 400;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) throw new BadRequest(`${field} must be a non-empty string`);
  return v;
};
const num = (v: unknown, field: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new BadRequest(`${field} must be a number in [${min}, ${max}]`);
  return v;
};

function parseIntervention(v: unknown, i: number): Intervention {
  const f = `interventions[${i}]`;
  if (!isObj(v)) throw new BadRequest(`${f} must be an object`);
  switch (v.kind) {
    case 'hold':
      return { kind: 'hold', connection: str(v.connection, `${f}.connection`), ...(v.maxHold !== undefined ? { maxHold: num(v.maxHold, `${f}.maxHold`, 0, 120) } : {}) };
    case 'release':
      return { kind: 'release', connection: str(v.connection, `${f}.connection`) };
    case 'prioritise':
      return { kind: 'prioritise', train: str(v.train, `${f}.train`), ...(v.boost !== undefined ? { boost: num(v.boost, `${f}.boost`, -100, 100) } : {}) };
    case 'platform':
      return {
        kind: 'platform',
        train: str(v.train, `${f}.train`),
        stopIndex: num(v.stopIndex, `${f}.stopIndex`, 0, 1000),
        platform: num(v.platform, `${f}.platform`, 1, 100),
      };
    case 'reroute':
      if (!Array.isArray(v.avoid) || v.avoid.length === 0 || v.avoid.length > 20) throw new BadRequest(`${f}.avoid must be a non-empty array`);
      return { kind: 'reroute', train: str(v.train, `${f}.train`), avoid: v.avoid.map((s, j) => str(s, `${f}.avoid[${j}]`)) };
    default:
      throw new BadRequest(`${f}.kind is not a known intervention`);
  }
}

/** Parses an untrusted policy, filling defaults. Unknown keys are rejected so typos don't pass silently. */
export function parsePolicy(v: unknown): Policy {
  if (v === undefined || v === null) return { ...DEFAULT_POLICY };
  if (!isObj(v)) throw new BadRequest('policy must be an object');
  const allowed = new Set(['holdConnections', 'allowPlatformChange', 'dispatch', 'lookahead', 'interventions']);
  for (const k of Object.keys(v)) if (!allowed.has(k)) throw new BadRequest(`policy.${k} is not a known setting`);
  const p: Policy = { ...DEFAULT_POLICY, interventions: [] };
  if (v.holdConnections !== undefined) {
    if (typeof v.holdConnections !== 'boolean') throw new BadRequest('policy.holdConnections must be boolean');
    p.holdConnections = v.holdConnections;
  }
  if (v.allowPlatformChange !== undefined) {
    if (typeof v.allowPlatformChange !== 'boolean') throw new BadRequest('policy.allowPlatformChange must be boolean');
    p.allowPlatformChange = v.allowPlatformChange;
  }
  if (v.dispatch !== undefined) {
    if (v.dispatch !== 'fifo' && v.dispatch !== 'priority' && v.dispatch !== 'schedule') throw new BadRequest('policy.dispatch must be fifo, priority or schedule');
    p.dispatch = v.dispatch;
  }
  if (v.lookahead !== undefined) p.lookahead = num(v.lookahead, 'policy.lookahead', 0, 60);
  if (v.interventions !== undefined) {
    if (!Array.isArray(v.interventions) || v.interventions.length > 200) throw new BadRequest('policy.interventions must be an array (max 200)');
    p.interventions = v.interventions.map(parseIntervention);
  }
  return p;
}
