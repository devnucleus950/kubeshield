#!/usr/bin/env bash
# End-to-end check of the whole Phase 1 pipeline:
#   simulator -> ingest API -> Redis stream -> worker -> Postgres
#
# Starts from a clean state, runs migrations, starts both services, runs the
# shell-attack, baseline and malformed scenarios, waits up to 10 s, then asserts
# on what is in the database. Exits non-zero on any failure.
#
# It uses its OWN database (kubeshield_e2e), stream prefix (e2e:) and port (4010),
# so it never touches your dev data and can run while `npm run dev` is running.
# Set KEEP=1 to keep the e2e database and logs for inspection.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

E2E_DB=kubeshield_e2e
E2E_PORT=4010
E2E_PREFIX="e2e:"
LOG_DIR=$(mktemp -d)
PIDS=()
RESULT=1

step() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok: %s\n' "$*"; }

fail() {
  echo "E2E FAILED: $*" >&2
  for f in "$LOG_DIR"/*.log; do
    [ -e "$f" ] && { echo "--- last lines of $f" >&2; tail -n 15 "$f" >&2; }
  done
  exit 1
}

cleanup() {
  # Stop services gracefully (SIGINT is what Ctrl+C sends), then force after 15 s.
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -INT "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 30); do
    alive=0
    for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1; done
    [ "$alive" = 0 ] && break
    sleep 0.5
  done
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true; done

  if [ "${KEEP:-0}" != 1 ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
    admin -c "DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)" >/dev/null 2>&1 || true
    redis-cli -u "$REDIS_URL" --scan --pattern "${E2E_PREFIX}*" 2>/dev/null | xargs -r redis-cli -u "$REDIS_URL" del >/dev/null 2>&1 || true
  fi
  if [ "$RESULT" = 0 ]; then rm -rf "$LOG_DIR"; else echo "logs kept in $LOG_DIR" >&2; fi
}
trap cleanup EXIT

# node lives in nvm, which non-interactive shells do not load by themselves.
if ! command -v node >/dev/null && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null
fi

step "Checking tools"
for tool in node npm docker psql redis-cli jq curl openssl; do
  command -v "$tool" >/dev/null || fail "$tool is not installed (see docs/setup.md)"
done
ok "node $(node --version), $(docker --version | cut -d, -f1)"

step "Preparing the project"
[ -d node_modules ] || npm ci --silent
bash scripts/init-env.sh
set -a; . ./.env; set +a
docker compose up -d --wait >/dev/null || fail "docker compose could not bring Redis and Postgres up healthy"
ok "redis and postgres are healthy"

admin() { PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p 5433 -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -tAq "$@"; }
db() { PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p 5433 -U "$POSTGRES_USER" -d "$E2E_DB" -v ON_ERROR_STOP=1 -tAq "$@"; }
rcli() { redis-cli -u "$REDIS_URL" "$@"; }

step "Starting from a clean state"
if (exec 3<>/dev/tcp/127.0.0.1/$E2E_PORT) 2>/dev/null; then fail "port $E2E_PORT is already in use"; fi
admin -c "DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)"
admin -c "CREATE DATABASE ${E2E_DB}"
rcli --scan --pattern "${E2E_PREFIX}*" | xargs -r redis-cli -u "$REDIS_URL" del >/dev/null
# Everything started below inherits these, which override the values in .env.
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5433/${E2E_DB}"
export STREAM_PREFIX="$E2E_PREFIX" INGEST_PORT="$E2E_PORT" INGEST_HOST=127.0.0.1
ok "fresh database ${E2E_DB}, no ${E2E_PREFIX}* keys in Redis"

step "Running migrations (twice, to prove it is repeatable)"
npm run -s db:migrate >"$LOG_DIR/migrate.log" 2>&1 || fail "first migration run failed"
npm run -s db:migrate >>"$LOG_DIR/migrate.log" 2>&1 || fail "second migration run failed"
grep -q "Applied: 001_events.sql" "$LOG_DIR/migrate.log" || fail "first run did not apply 001_events.sql"
grep -q "Nothing to apply" "$LOG_DIR/migrate.log" || fail "second run was not a no-op"
ok "applied once, second run did nothing"

step "Starting ingest (port $E2E_PORT) and worker"
node --env-file=.env --import tsx services/ingest/src/server.ts >"$LOG_DIR/ingest.log" 2>&1 & PIDS+=($!)
node --env-file=.env --import tsx services/worker/src/main.ts >"$LOG_DIR/worker.log" 2>&1 & PIDS+=($!)
ready=0
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${E2E_PORT}/readyz" >/dev/null 2>&1 && { ready=1; break; }
  sleep 0.25
done
[ "$ready" = 1 ] || fail "ingest did not become ready within 15 s"
ok "ingest answers /readyz"

SIM=(node --env-file=.env --import tsx tools/simulator/src/cli.ts)
# A fixed seed makes the baseline size knowable in advance (random 20 to 50 otherwise).
baseline_n=$("${SIM[@]}" --scenario baseline --seed 1 --dry-run 2>/dev/null | jq length)
expected=$((4 + baseline_n))

step "Sending shell-attack (4 events) and baseline ($baseline_n events), time compressed with --rate"
npm run -s sim -- --scenario shell-attack --rate 20 >"$LOG_DIR/sim-attack.log" 2>&1 || fail "shell-attack: unexpected responses"
npm run -s sim -- --scenario baseline --seed 1 --rate 50 >"$LOG_DIR/sim-baseline.log" 2>&1 || fail "baseline: unexpected responses"
ok "every event got 202"

step "Waiting up to 10 s for $expected rows"
rows=0
for _ in $(seq 1 40); do
  rows=$(db -c "SELECT count(*) FROM events")
  [ "$rows" -ge "$expected" ] && break
  sleep 0.25
done

assert_eq() { # description, expected, actual
  [ "$2" = "$3" ] || fail "$1: expected '$2' but got '$3'"
  ok "$1 = $3"
}

ATTACK="rule IN ('Terminal shell in container','Launch Suspicious Network Tool in Container','Read sensitive file untrusted','Unexpected outbound connection destination')"

step "Checking the database"
assert_eq "total rows" "$expected" "$(db -c "SELECT count(*) FROM events")"
assert_eq "baseline rows" "$baseline_n" "$(db -c "SELECT count(*) FROM events WHERE NOT ($ATTACK)")"
assert_eq "attack rows" 4 "$(db -c "SELECT count(*) FROM events WHERE $ATTACK")"
assert_eq "containers shared by the 4 attack events" 1 "$(db -c "SELECT count(DISTINCT container_id) FROM events WHERE $ATTACK")"
assert_eq "attack priority order" "Notice,Warning,Error,Critical" \
  "$(db -c "SELECT string_agg(priority, ',' ORDER BY occurred_at) FROM events WHERE $ATTACK")"
assert_eq "events whose parent is the first bash" 3 \
  "$(db -c "SELECT count(*) FROM events a JOIN events b ON b.container_id = a.container_id AND b.proc_ppid = a.proc_pid WHERE a.rule = 'Terminal shell in container' AND b.rule <> a.rule")"
assert_eq "file_path for the sensitive read" "/etc/shadow" "$(db -c "SELECT file_path FROM events WHERE rule = 'Read sensitive file untrusted'")"
assert_eq "remote_port for the outbound connection" 4444 "$(db -c "SELECT remote_port FROM events WHERE rule = 'Unexpected outbound connection destination'")"
assert_eq "remote_ip is set for the outbound connection" t "$(db -c "SELECT remote_ip IS NOT NULL FROM events WHERE rule = 'Unexpected outbound connection destination'")"
assert_eq "distinct event_ids" "$expected" "$(db -c "SELECT count(DISTINCT event_id) FROM events")"

step "Checking Redis"
assert_eq "dead-letter entries" 0 "$(rcli xlen "${E2E_PREFIX}events:dead")"
# Give the worker a moment to acknowledge, then nothing may be left pending.
for _ in $(seq 1 20); do
  pending=$(rcli xpending "${E2E_PREFIX}events:raw" workers | head -n1)
  [ "$pending" = 0 ] && break
  sleep 0.25
done
assert_eq "pending (unacknowledged) messages" 0 "$pending"

step "Sending malformed payloads (must all be rejected, nothing stored)"
npm run -s sim -- --scenario malformed >"$LOG_DIR/sim-malformed.log" 2>&1 || fail "malformed: some payload was not rejected as expected"
sleep 1
assert_eq "rows after malformed" "$expected" "$(db -c "SELECT count(*) FROM events")"

step "Stopping services cleanly"
for pid in "${PIDS[@]}"; do kill -INT "$pid"; done
for _ in $(seq 1 40); do
  alive=0
  for pid in "${PIDS[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
  [ "$alive" = 0 ] && break
  sleep 0.5
done
grep -q "shutdown complete" "$LOG_DIR/ingest.log" || fail "ingest did not shut down cleanly"
grep -q "shutdown complete" "$LOG_DIR/worker.log" || fail "worker did not shut down cleanly"
ok "both services logged 'shutdown complete'"

RESULT=0
printf '\nE2E PASSED\n'
