// Command-line entry: `npm run db:migrate` from the repo root.
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}
try {
  const applied = await migrate(url);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply, database is up to date.');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
