// Config comes from environment variables and is validated at startup.
// A missing or malformed variable stops the process with a clear message
// instead of failing mysteriously later.
import { z } from 'zod';

const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Optional prefix for stream names. Tests set it so they never touch dev data.
  STREAM_PREFIX: z.string().default(''),
};

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

export const ingestConfigSchema = z.object({
  ...common,
  INGEST_HOST: z.string().default('127.0.0.1'), // bound to loopback so only this machine can reach it
  INGEST_PORT: port.default(4000),
  INGEST_API_KEY: z.string().min(16, 'must be at least 16 characters (use: openssl rand -hex 32)'),
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  STREAM_MAXLEN: positiveInt.default(100_000),
});

export const workerConfigSchema = z.object({
  ...common,
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  WORKER_BATCH_SIZE: positiveInt.max(1000).default(50),
  WORKER_MAX_DELIVERIES: positiveInt.default(5),
  // Tuning knobs. The defaults match the spec; drills and tests shorten them.
  WORKER_BLOCK_MS: positiveInt.default(5000), // how long a read waits when the stream is empty
  WORKER_RECLAIM_IDLE_MS: z.coerce.number().int().min(0).default(60_000), // a message idle this long is taken over
  WORKER_RECLAIM_INTERVAL_MS: positiveInt.default(30_000), // how often the reclaim job runs
});

export const simulatorConfigSchema = z.object({
  ...common,
  INGEST_PORT: port.default(4000),
  INGEST_API_KEY: z.string().min(1, 'is required so the simulator can authenticate'),
});

export type IngestConfig = z.infer<typeof ingestConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type SimulatorConfig = z.infer<typeof simulatorConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => {
    const name = i.path.join('.') || '(config)';
    const missing = env[name] === undefined ? ' (not set)' : '';
    return `  - ${name}: ${i.message}${missing}`;
  });
  throw new ConfigError(
    `Invalid configuration. Fix these in .env (see .env.example):\n${lines.join('\n')}`,
  );
}

// Entry points call this: print the problem and exit instead of a stack trace.
export function loadConfigOrExit<S extends z.ZodType>(schema: S): z.infer<S> {
  try {
    return parseConfig(schema);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

// Same server, different database name. Used by tests (kubeshield_test).
export function withDatabase(databaseUrl: string, dbName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}
