import { defineConfig } from 'vitest/config';

// Load .env so integration tests can find Redis and Postgres.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env: unit tests do not need it.
}

export default defineConfig({
  test: {
    include: ['{packages,services,tools}/*/src/**/*.test.ts'],
    // Integration tests share one Redis and one Postgres, so run files one at a time.
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 15_000,
  },
});
