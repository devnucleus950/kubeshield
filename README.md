# KubeShield

A Kubernetes runtime security platform, built in phases. **Phase 1** (this repo) is the
data pipeline: a simulator sends Falco-style security events to an API, a queue buffers
them, and a worker stores them in Postgres. No Kubernetes or Falco is needed yet.

```
 simulator ──HTTP──▶ ingest API ──XADD──▶ Redis Stream ──XREADGROUP──▶ worker ──INSERT──▶ Postgres
 (stands in          (validates,          (events:raw,                 (normalizes,        (events table)
  for Falco)          202 only after       consumer group              acks only after
                      Redis has it)        "workers")                  the commit)
                                              │
                                              └── events:dead  (messages that can never succeed)
```

Real Falco (Phase 6) will replace only the simulator. Nothing else changes.

## Run it (about 5 minutes)

You need **Node.js 20.6 or newer**, **Docker** with the compose plugin, and (optional, for
poking around) `redis-cli` and `psql`.

```bash
git clone https://github.com/devnucleus950/kubeshield.git && cd kubeshield
npm install
npm run env:init            # creates .env with a random API key and database password
docker compose up -d --wait   # Redis and Postgres, both healthy
npm run db:migrate          # creates the events table
npm run dev                 # starts the ingest API and the worker (Ctrl+C stops both)
```

In a second terminal, send an attack and look at what was stored:

```bash
npm run sim -- --scenario shell-attack     # four events over about 11 seconds
npm run db:count                           # shows them in Postgres
```

To check everything at once: `npm run e2e` (uses its own database, never touches yours).

To try the API by hand:

```bash
KEY=$(grep '^INGEST_API_KEY=' .env | cut -d= -f2)

curl -s -X POST http://127.0.0.1:4000/v1/events \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"time":"2026-11-24T10:31:07Z","rule":"Terminal shell in container","priority":"Notice","output":"a shell"}'
# {"accepted":1,"event_ids":["..."]}

curl -s "http://127.0.0.1:4000/v1/events?limit=5" -H "x-api-key: $KEY"   # latest stored events (dev only)
curl -s http://127.0.0.1:4000/readyz                                     # is Redis and Postgres reachable?
```

Use `127.0.0.1`, not `localhost`: on some machines `localhost` resolves to IPv6 first and stalls.

## What happens between `POST /v1/events` and the row in Postgres

1. **Ingest** rejects bodies over 1 MB (413) and checks the `x-api-key` header in constant
   time (401, with no hint whether it was missing or wrong).
2. It validates every event against a schema. If any event in a batch is invalid the whole
   request gets 400 with the array positions of the problems. Nothing is partly accepted.
3. It gives each event a UUID and writes them all to the Redis stream `events:raw` in one
   pipeline. **Only after Redis confirms does it answer 202.** If Redis is down it answers
   503 with `Retry-After`, never 202.
4. The **worker** reads batches of up to 50 through a consumer group. Redis remembers each
   message as "delivered but not acknowledged" until the worker says it is done.
5. It normalizes each event (dotted Falco names become typed columns) and inserts the batch
   in one transaction with `ON CONFLICT (event_id) DO NOTHING`.
6. **Only after the commit** does it acknowledge (`XACK`) the batch.

A crash anywhere in that chain means redelivery, not loss. Step 5's primary key makes the
redelivery harmless, so each event ends up in Postgres exactly once.

| Failure | What happens |
| --- | --- |
| Postgres down | Worker keeps the batch, retries with backoff (500 ms doubling to 30 s), loses nothing |
| Redis down | API answers 503 + `Retry-After`; worker reconnects and resumes by itself |
| Worker killed | Its unacknowledged messages are taken over by the reclaim job after 60 s idle |
| Message that can never work (bad payload, a row Postgres rejects) | Moved to `events:dead` with a reason, acknowledged, worker carries on |
| Same message delivered twice | Second insert does nothing; counted as a duplicate in the logs |

`docs/failure-drills.md` has the results of breaking each of these on purpose.

## Simulator

`npm run sim -- --scenario <name> [options]`

| Scenario | Events | What it models |
| --- | --- | --- |
| `baseline` | 20 to 50 | Harmless low-priority noise across 3 pods |
| `shell-attack` | 4 | Shell in a container, then a suspicious tool, a sensitive file read, an outbound connection on port 4444. One container, rising priority, consistent process tree |
| `privileged-container` | 1 | A container started in privileged mode |
| `file-tamper` | 3 | A write under `/etc`, a write to a system binary directory, a change to a cron file |
| `burst` | 500 | One low-priority event type at high speed, for load testing (100 per second by default) |
| `malformed` | 6 | Six invalid payloads that must all be rejected (400, or 413 for the oversized one) |

| Option | Default | Meaning |
| --- | --- | --- |
| `--target` | `http://127.0.0.1:4000` | Ingest API base URL |
| `--api-key` | `INGEST_API_KEY` from `.env` | Sent as the `x-api-key` header |
| `--count` | 1 | Run the scenario this many times, each on a new pod |
| `--rate` | natural timing | Events per second. Without it, events are sent at their real offsets (shell-attack really takes 11 s). `burst` defaults to 100. The `time` in each event always shows the intended offset, even when sent fast |
| `--seed` | random | Same seed gives the same pod names, IPs and process ids |
| `--namespace` | `production` | Kubernetes namespace written into the events |
| `--dry-run` | off | Print the events as JSON instead of sending them |

The simulator exits non-zero if any response is not what the scenario expects, so a wrong
API key or a broken API is obvious. All rule names and field names live in
`tools/simulator/src/rules.ts`; check them against the real Falco rules in Phase 6.

## Configuration

Everything comes from environment variables, validated at startup. A missing or malformed
value stops the process with a message naming it. `.env.example` lists every setting with
safe local defaults, and `.env` (git-ignored) is loaded with Node's `--env-file` flag.

| Variable | Default | Used by |
| --- | --- | --- |
| `INGEST_HOST`, `INGEST_PORT` | `127.0.0.1`, `4000` | ingest |
| `INGEST_API_KEY` | generated by `npm run env:init` | ingest, simulator |
| `REDIS_URL` | `redis://127.0.0.1:6379` | ingest, worker |
| `DATABASE_URL` | `postgres://kubeshield:<password>@127.0.0.1:5433/kubeshield` | ingest, worker, migrate |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `kubeshield`, generated, `kubeshield` | docker compose |
| `STREAM_MAXLEN` | `100000` | ingest (approximate cap on the stream) |
| `WORKER_BATCH_SIZE`, `WORKER_MAX_DELIVERIES` | `50`, `5` | worker |
| `WORKER_BLOCK_MS`, `WORKER_RECLAIM_IDLE_MS`, `WORKER_RECLAIM_INTERVAL_MS` | `5000`, `60000`, `30000` | worker (optional tuning) |
| `LOG_LEVEL` | `info` | all |

Postgres is on host port **5433** (not 5432) so it never clashes with a Postgres installed
on your machine. Both databases listen on `127.0.0.1` only.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Ingest API and worker together, restarting on code changes |
| `npm run db:migrate` | Applies new files from `db/migrations/` (safe to run repeatedly) |
| `npm run db:count` | Shows how many events are stored, by rule and priority |
| `npm run sim -- ...` | The simulator (above) |
| `npm run test:unit` | Fast tests, no Docker needed |
| `npm test` | All tests; needs `docker compose up -d`. Uses a separate `kubeshield_test` database |
| `npm run e2e` | The whole pipeline end to end, against its own database, port and stream prefix |
| `npm run build` | Type-checks every package (`tsc -b`, strict mode) |
| `npm run env:init` | Creates `.env` with generated secrets; never overwrites an existing one |

## Repository layout

```
packages/shared/    schemas, normalize(), config parser, stream names (imports nothing else)
services/ingest/    the HTTP API (app.ts builds it, server.ts listens)
services/worker/    consumer loop, reclaim job, batch insert
tools/simulator/    the six scenarios and the CLI
tools/migrate/      the tiny SQL migration runner and db:count
db/migrations/      numbered .sql files
scripts/            dev.mjs, e2e.sh, init-env.sh
docs/               phase1.md (the brief), setup.md, failure-drills.md
```

Services and tools import from `shared`, never from each other. Route files only parse the
request, call a function and return the result.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `permission denied` talking to Docker | Log out and back in after being added to the `docker` group |
| `node: command not found` in a new terminal | Open a new terminal; check `~/.bashrc` loads nvm |
| `port is already allocated` | Something uses 6379 or 5433. Find it with `sudo ss -ltnp`, or change the host port in `docker-compose.yml` and `.env` |
| `Invalid configuration ...` on startup | The message names the variable; fix it in `.env` |
| Postgres rejects the password after you regenerated `.env` | The database volume keeps the first password. `docker compose down -v` (deletes the data) and start again |
| Everything is slow or failing | Run `docker compose ps` first. Half of all errors are "the database is not running" |

## Not in Phase 1

Pod enrichment from the Kubernetes API and detection rules (Phase 2), incidents and risk
scoring (Phase 3), the dashboard and logins (Phase 4), alerts and automated responses
(Phase 5), real Falco on a `kind` cluster and a Helm chart (Phase 6). A rate limit on the API
(for example 600 requests per minute per key) is a known stretch goal and is not implemented.
