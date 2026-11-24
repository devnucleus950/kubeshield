// Runs once before all tests. Creates the kubeshield_test database and applies
// migrations to it, so integration tests never touch your dev data.
// Unit-only runs (KS_UNIT_ONLY=1) and machines without Postgres skip this.
import pg from 'pg';
import { migrate } from '../tools/migrate/src/migrate.js';
import { withDatabase } from '../packages/shared/src/config.js';

export const TEST_DB = 'kubeshield_test';

export default async function setup(): Promise<void> {
  const devUrl = process.env.DATABASE_URL;
  if (process.env.KS_UNIT_ONLY || !devUrl) return;

  const admin = new pg.Client({ connectionString: devUrl, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch {
    console.warn('[test setup] Postgres not reachable: integration tests will fail. Run: docker compose up -d');
    return;
  }
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  await migrate(withDatabase(devUrl, TEST_DB));
}
