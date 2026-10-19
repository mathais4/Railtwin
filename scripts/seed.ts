import { fileURLToPath } from 'node:url';
import { connect } from '../src/db/client.ts';
import { saveScenario } from '../src/db/repository.ts';
import { builtInScenarios } from '../src/data/scenarios.ts';
import { migrate } from './migrate.ts';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL');
  const db = await connect(url);
  await migrate(db);
  for (const sc of builtInScenarios) {
    await saveScenario(db, sc);
    console.log(`seeded ${sc.id} (${sc.timetable.trains.length} trains, ${sc.observed?.length ?? 0} observed times)`);
  }
  await db.end();
}
