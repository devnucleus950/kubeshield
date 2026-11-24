// Prints how many events are stored, so you can see the pipeline working.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const total = await client.query<{ n: string }>('SELECT count(*) AS n FROM events');
  console.log(`events total: ${total.rows[0]?.n ?? '0'}`);

  const byRule = await client.query<{ rule: string; priority: string; n: string }>(
    `SELECT rule, priority, count(*) AS n FROM events
     GROUP BY rule, priority, priority_rank ORDER BY priority_rank, rule`,
  );
  if (byRule.rows.length) console.table(byRule.rows);
} catch (err) {
  console.error(`db:count failed: ${(err as Error).message}`);
  process.exit(1);
} finally {
  await client.end();
}
