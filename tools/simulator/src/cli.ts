// `npm run sim -- --scenario <name> [options]`
import { parseArgs } from 'node:util';
import { createClient } from './client.js';
import { buildPlan } from './plan.js';
import { seedFrom } from './rng.js';
import { execute, sendTimes, summarize } from './run.js';
import { SCENARIOS, findScenario } from './scenarios/index.js';

const USAGE = `Usage: npm run sim -- --scenario <name> [options]

Scenarios:
${SCENARIOS.map((s) => `  ${s.name.padEnd(22)}${s.description}`).join('\n')}

Options:
  --scenario <name>     required
  --target <url>        ingest API base URL (default http://127.0.0.1:4000)
  --api-key <key>       default: INGEST_API_KEY from .env
  --count <n>           run the scenario n times, each on a new pod (default 1)
  --rate <per-second>   send at a fixed rate; default is each scenario's natural timing
  --seed <value>        reproducible pod names, IPs and pids
  --namespace <name>    Kubernetes namespace in the events (default production)
  --dry-run             print the events as JSON instead of sending them
  --help`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function positiveNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number, got "${value}"`);
  return n;
}

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        scenario: { type: 'string' },
        target: { type: 'string' },
        'api-key': { type: 'string' },
        count: { type: 'string' },
        rate: { type: 'string' },
        seed: { type: 'string' },
        namespace: { type: 'string', default: 'production' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    return fail((err as Error).message);
  }
})();

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.scenario) fail('--scenario is required');
const scenario = findScenario(values.scenario);
if (!scenario) fail(`unknown scenario "${values.scenario}"`);

const count = positiveNumber('count', values.count) ?? 1;
if (!Number.isInteger(count)) fail('--count must be a whole number');
const rate = positiveNumber('rate', values.rate) ?? scenario.defaultRate;
const seed = seedFrom(values.seed);
const target = values.target ?? `http://127.0.0.1:${process.env.INGEST_PORT ?? '4000'}`;
const apiKey = values['api-key'] ?? process.env.INGEST_API_KEY;

const plan = buildPlan(scenario, { count, seed, namespace: values.namespace, start: new Date() });
const times = sendTimes(plan, rate);

// ---- dry run: show what would be sent, send nothing ----
if (values['dry-run']) {
  const shown = plan.map((item) => {
    let body: unknown = item.body;
    if (item.body.length > 4000) body = `<${item.body.length} bytes omitted>`;
    else {
      try {
        body = JSON.parse(item.body);
      } catch {
        /* not JSON (that is the point of some malformed payloads): show the raw text */
      }
    }
    return { send_at_ms: Math.round(times[plan.indexOf(item)]!), expect: item.expect, body };
  });
  console.log(JSON.stringify(shown, null, 2));
  console.error(`dry run: ${plan.length} event(s), seed ${seed}, nothing sent`);
  process.exit(0);
}

if (!apiKey) fail('no API key: set INGEST_API_KEY in .env or pass --api-key');

const seconds = ((times.at(-1) ?? 0) / 1000).toFixed(1);
console.log(`scenario ${scenario.name}: ${plan.length} event(s) x ${count} run(s) -> ${target}  (seed ${seed}, ~${seconds}s)`);

const verbose = plan.length <= 50;
const outcomes = await execute(plan, {
  send: createClient(target, apiKey),
  rate,
  onOutcome(o, sentAtMs) {
    if (!verbose) return;
    const status = o.result.status ?? `ERR ${o.result.error}`;
    console.log(`  +${(sentAtMs / 1000).toFixed(1)}s  ${String(status).padEnd(4)} ${o.ok ? 'ok  ' : 'FAIL'} ${o.item.label}`);
  },
});

const { byStatus, failed } = summarize(outcomes);
console.log(`responses: ${[...byStatus].map(([s, n]) => `${s} x${n}`).join(', ')}`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.length} of ${outcomes.length} did not get the expected response`);
  process.exit(1);
}
console.log(`all ${outcomes.length} responses as expected`);
