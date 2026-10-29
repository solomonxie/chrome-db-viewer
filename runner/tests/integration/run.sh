#!/usr/bin/env bash
# Integration test for dbui-runner against throwaway postgres:17 and redis:7 containers.
# Usage: runner/tests/integration/run.sh [pytest args]   (builds first if runner/build/dbui-runner is missing)
#        runner/tests/integration/run.sh --record     re-records the extension's replay fixture
# Needs: docker, uv (runs pytest without touching the system Python).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
runner_dir="$(cd "$here/../.." && pwd)"
fixtures="$runner_dir/tests/fixtures"
pg_port="${DBUI_TEST_PG_PORT:-15432}"
redis_port="${DBUI_TEST_REDIS_PORT:-16379}"
pg_name="dbui-test-pg-$$"
redis_name="dbui-test-redis-$$"

if [[ ! -x "$runner_dir/build/dbui-runner" ]]; then
  cmake -S "$runner_dir" -B "$runner_dir/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$runner_dir/build" -j
fi

cleanup() {
  docker rm -f "$pg_name" "$redis_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --rm --name "$pg_name" -p "127.0.0.1:$pg_port:5432" \
  -e POSTGRES_PASSWORD=dbui-test -e POSTGRES_DB=dbui \
  -v "$fixtures/seed.sql:/docker-entrypoint-initdb.d/seed.sql:ro" postgres:17 >/dev/null
docker run -d --rm --name "$redis_name" -p "127.0.0.1:$redis_port:6379" redis:7 >/dev/null

echo "waiting for postgres and redis…"
pg_ready=0
for _ in $(seq 1 60); do
  # The init script runs against a temporary server first; wait for the real one on TCP.
  if docker exec "$pg_name" pg_isready -h 127.0.0.1 -U postgres -d dbui >/dev/null 2>&1 \
     && docker exec "$pg_name" psql -h 127.0.0.1 -U postgres -d dbui -tAc "select count(*) from shop.events" 2>/dev/null | grep -q 5000; then
    pg_ready=1
    break
  fi
  if ! docker inspect "$pg_name" >/dev/null 2>&1; then break; fi  # exited (seed error)
  sleep 1
done
if [[ "$pg_ready" != 1 ]]; then
  echo "postgres did not come up with the seed data:" >&2
  docker logs "$pg_name" 2>&1 | tail -20 >&2 || true
  exit 1
fi
until docker exec "$redis_name" redis-cli ping >/dev/null 2>&1; do sleep 0.5; done
docker exec -i "$redis_name" redis-cli >/dev/null < "$fixtures/redis-seed.txt"

export DBUI_RUNNER_BIN="$runner_dir/build/dbui-runner"
export DBUI_TEST_PG_PORT="$pg_port" DBUI_TEST_REDIS_PORT="$redis_port" DBUI_TEST_PG_PASSWORD=dbui-test
export DBUI_TEST_PG_CONTAINER="$pg_name"
export DBUI_RUNNER_LOG="${DBUI_RUNNER_LOG:-$runner_dir/build/runner-test.log}"

if [[ "${1:-}" == "--record" ]]; then
  # Re-records extension/tests/fixtures/runner/sessions.json from a real session.
  uv run --no-project --with pytest python "$here/record_fixture.py"
else
  uv run --no-project --with pytest pytest -q "$here/test_runner.py" "$@"
fi
