import type { Scenario, Segment, Station, Train } from '../src/model/types.ts';

/** A small hand-built line for focused tests: A — B — C (B–C single track by default). */
export function line(opts: { bcTracks?: 1 | 2; platformsB?: number; trains: Train[]; connections?: Scenario['timetable']['connections'] }): Scenario {
  const stations: Station[] = [
    { id: 'A', name: 'A', platforms: 3, x: 0, y: 0 },
    { id: 'B', name: 'B', platforms: opts.platformsB ?? 3, x: 10, y: 0 },
    { id: 'C', name: 'C', platforms: 3, x: 20, y: 0 },
  ];
  const segments: Segment[] = [
    { id: 'AB', from: 'A', to: 'B', runTime: 10, tracks: 2, headway: 3 },
    { id: 'BC', from: 'B', to: 'C', runTime: 10, tracks: opts.bcTracks ?? 1, headway: 3 },
  ];
  return {
    id: 'test',
    name: 'test',
    description: '',
    network: { id: 'n', name: 'n', stations, segments },
    timetable: { trains: opts.trains, connections: opts.connections ?? [] },
    incidents: [],
  };
}

export function train(id: string, stops: Train['stops'], extra: Partial<Train> = {}): Train {
  return { id, name: id, kind: 'local', priority: 1, passengers: 100, stops, ...extra };
}
