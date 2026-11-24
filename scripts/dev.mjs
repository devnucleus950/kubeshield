// `npm run dev`: runs the ingest API and the worker together, each under
// `tsx watch` so they restart when you edit code. Ctrl+C stops both cleanly.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

const services = [
  { name: 'ingest', entry: 'services/ingest/src/server.ts' },
  { name: 'worker', entry: 'services/worker/src/main.ts' },
];

const children = services.map(({ name, entry }) => {
  const child = spawn(process.execPath, [tsxCli, 'watch', '--env-file=.env', entry], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    console.error(`[dev] ${name} exited (${signal ?? code})`);
    // If one service dies, stop the other so you notice instead of half-running.
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  // Safety net: the services have their own 10 s / 15 s shutdown limits.
  setTimeout(() => process.exit(1), 20_000).unref();
  Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.once('exit', r))))).then(() =>
    process.exit(0),
  );
}
// Ctrl+C in a terminal delivers SIGINT to the whole process group, so the children
// are already shutting down. Sending them a second signal would make tsx force-kill
// them mid-shutdown, so on SIGINT we just wait. `kill <pid>` (SIGTERM) only reaches
// this process, so that one is forwarded.
process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', stopAll);
