import type { Network, Timetable } from '../model/types.ts';
import { assignPlatforms, buildTrains, findConnections, type ServicePattern } from '../timetable/builder.ts';

/**
 * "Shannon Vale" — a fictional regional network built to exercise every
 * mechanism in the simulator: a double-track main line, two single-track
 * branches with passing loops, a slower single-track cut-off that offers a
 * diversionary route, interchange stations, and mixed-priority traffic.
 *
 *            Lough Arden                     Westhaven
 *                 |  (single)                   | (single)
 *              Corran                       Harbour Quay
 *                 |  (single)                   |
 *  Northgate — Ashby Jn — Millbrook — Riverside Central — Elm Park — Stonebridge
 *                   \______ cut-off (single) ______/
 */
export const sampleNetwork: Network = {
  id: 'shannon-vale',
  name: 'Shannon Vale Railway',
  stations: [
    { id: 'NGT', name: 'Northgate', platforms: 4, x: 0, y: 30, turnaround: 4 },
    { id: 'ASH', name: 'Ashby Junction', platforms: 3, x: 14, y: 30 },
    { id: 'MIL', name: 'Millbrook', platforms: 2, x: 27, y: 26 },
    { id: 'RVC', name: 'Riverside Central', platforms: 5, x: 42, y: 30, minDwell: 1.5 },
    { id: 'ELM', name: 'Elm Park', platforms: 2, x: 52, y: 34 },
    { id: 'STB', name: 'Stonebridge', platforms: 3, x: 64, y: 30 },
    { id: 'COR', name: 'Corran', platforms: 2, x: 20, y: 16 },
    { id: 'LGA', name: 'Lough Arden', platforms: 2, x: 28, y: 4 },
    { id: 'HBQ', name: 'Harbour Quay', platforms: 2, x: 50, y: 18 },
    { id: 'WHV', name: 'Westhaven', platforms: 2, x: 60, y: 6 },
  ],
  segments: [
    { id: 'NGT-ASH', from: 'NGT', to: 'ASH', runTime: 8, tracks: 2, headway: 3 },
    { id: 'ASH-MIL', from: 'ASH', to: 'MIL', runTime: 9, tracks: 2, headway: 3 },
    { id: 'MIL-RVC', from: 'MIL', to: 'RVC', runTime: 11, tracks: 2, headway: 3 },
    { id: 'RVC-ELM', from: 'RVC', to: 'ELM', runTime: 7, tracks: 2, headway: 3 },
    { id: 'ELM-STB', from: 'ELM', to: 'STB', runTime: 8, tracks: 2, headway: 3 },
    { id: 'ASH-COR', from: 'ASH', to: 'COR', runTime: 7, tracks: 1, headway: 2 },
    { id: 'COR-LGA', from: 'COR', to: 'LGA', runTime: 9, tracks: 1, headway: 2 },
    { id: 'RVC-HBQ', from: 'RVC', to: 'HBQ', runTime: 8, tracks: 2, headway: 3 },
    { id: 'HBQ-WHV', from: 'HBQ', to: 'WHV', runTime: 10, tracks: 1, headway: 2 },
    { id: 'ASH-RVC', from: 'ASH', to: 'RVC', runTime: 24, tracks: 1, headway: 3 },
  ],
};

const h = (hh: number, mm: number) => hh * 60 + mm;

export const samplePatterns: ServicePattern[] = [
  { id: 'IC-D', name: 'Northgate–Stonebridge Intercity', kind: 'intercity', priority: 3, passengers: 420, calls: ['NGT', 'ASH', 'RVC', 'STB'], first: h(6, 0), every: 60, count: 4, dwell: 1.5 },
  { id: 'IC-U', name: 'Stonebridge–Northgate Intercity', kind: 'intercity', priority: 3, passengers: 400, calls: ['STB', 'RVC', 'ASH', 'NGT'], first: h(6, 8), every: 60, count: 4, dwell: 1.5 },
  { id: 'LC-D', name: 'Northgate–Stonebridge stopper', kind: 'local', priority: 1, passengers: 160, calls: ['NGT', 'ASH', 'MIL', 'RVC', 'ELM', 'STB'], first: h(6, 15), every: 30, count: 7 },
  { id: 'LC-U', name: 'Stonebridge–Northgate stopper', kind: 'local', priority: 1, passengers: 170, calls: ['STB', 'ELM', 'RVC', 'MIL', 'ASH', 'NGT'], first: h(6, 20), every: 30, count: 7 },
  { id: 'BR-D', name: 'Ashby–Lough Arden branch', kind: 'branch', priority: 1, passengers: 60, calls: ['ASH', 'COR', 'LGA'], first: h(6, 13), every: 30, count: 7 },
  { id: 'BR-U', name: 'Lough Arden–Ashby branch', kind: 'branch', priority: 1, passengers: 70, calls: ['LGA', 'COR', 'ASH'], first: h(6, 11), every: 30, count: 7 },
  { id: 'CS-D', name: 'Riverside–Westhaven coast', kind: 'coast', priority: 2, passengers: 110, calls: ['RVC', 'HBQ', 'WHV'], first: h(6, 38), every: 60, count: 4 },
  { id: 'CS-U', name: 'Westhaven–Riverside coast', kind: 'coast', priority: 2, passengers: 120, calls: ['WHV', 'HBQ', 'RVC'], first: h(7, 0), every: 60, count: 3 },
  { id: 'FR-D', name: 'Northgate–Riverside freight', kind: 'freight', priority: 0, passengers: 0, calls: ['NGT', 'RVC'], first: h(6, 40), every: 120, count: 2, runTimeFactor: 1.35, avoid: ['ASH-MIL'] },
  { id: 'FR-U', name: 'Riverside–Northgate freight', kind: 'freight', priority: 0, passengers: 0, calls: ['RVC', 'NGT'], first: h(7, 25), every: 120, count: 2, runTimeFactor: 1.35, avoid: ['MIL-RVC'] },
];

export function buildSampleTimetable(): Timetable {
  const trains = buildTrains(sampleNetwork, samplePatterns);
  assignPlatforms(sampleNetwork, trains);
  const connections = findConnections(trains, [
    { station: 'ASH', fromKinds: ['intercity', 'local'], toKinds: ['branch'], minTransfer: 3, window: 12, maxHold: 6, passengers: 45, missPenalty: 30 },
    { station: 'ASH', fromKinds: ['branch'], toKinds: ['local', 'intercity'], minTransfer: 3, window: 12, maxHold: 5, passengers: 35, missPenalty: 25 },
    { station: 'RVC', fromKinds: ['intercity'], toKinds: ['coast'], minTransfer: 3, window: 12, maxHold: 8, passengers: 70, missPenalty: 60 },
    { station: 'RVC', fromKinds: ['coast'], toKinds: ['intercity'], minTransfer: 3, window: 12, maxHold: 6, passengers: 60, missPenalty: 60 },
  ]);
  return { trains, connections };
}
