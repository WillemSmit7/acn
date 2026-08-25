#!/usr/bin/env bash
# ACN Increment 1 end-to-end test.
#
# Drives the full vertical slice automatically:
#   healthy baseline -> break R2-R3 -> observe failure -> restore -> observe recovery
# then reads Firestore back and asserts the expected events exist.
#
# Prerequisites (already running in other terminals):
#   ./lab/deploy.sh
#   firebase emulators:start
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# Fail before starting anything if Docker is unreachable.
# shellcheck source=../lab/lib/docker.sh
source "${REPO_ROOT}/lab/lib/docker.sh"
resolve_docker || exit 2

export FIRESTORE_EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8080}"
export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-acn-local}"
export HEALTH_CHECK_INTERVAL_SECONDS="${HEALTH_CHECK_INTERVAL_SECONDS:-5}"
export HEALTH_CHECK_TIMEOUT_SECONDS=2
export LOG_LEVEL=info

SERVICE_LOG="$(mktemp -t acn-health-XXXXXX.log)"

# The service is stopped by signalling its whole process group. Signalling only
# the pid kills the npm/npx wrapper and leaves the actual node process orphaned
# and still writing to Firestore, which silently corrupts later runs.
cleanup() {
  if [ -n "${SERVICE_PID:-}" ] && kill -0 "${SERVICE_PID}" 2>/dev/null; then
    kill -TERM "-${SERVICE_PID}" 2>/dev/null || kill -TERM "${SERVICE_PID}" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "${SERVICE_PID}" 2>/dev/null || return 0
      sleep 0.25
    done
    kill -KILL "-${SERVICE_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Clearing previous emulator data"
./scripts/reset-firestore.sh

echo "==> Restoring the lab to a healthy baseline"
./lab/scenarios/03-restore-network.sh

echo "==> Starting the Health Service (interval ${HEALTH_CHECK_INTERVAL_SECONDS}s)"
# setsid so the service leads its own process group - see cleanup() above.
# Invoked directly rather than through 'npm run health-service', which uses
# tsx watch: a file watcher is the wrong thing to run inside a test.
setsid npx tsx services/health-service/src/index.ts > "${SERVICE_LOG}" 2>&1 &
SERVICE_PID=$!

# A service that died at startup must surface here, not 45 seconds later as a
# confusing "no health checks were recorded" assertion failure after the lab
# has already been broken and restored.
sleep 3
if ! kill -0 "${SERVICE_PID}" 2>/dev/null; then
  echo "ERROR: the Health Service exited immediately after starting." >&2
  echo "----------------------- service log -----------------------" >&2
  cat "${SERVICE_LOG}" >&2
  echo "-----------------------------------------------------------" >&2
  exit 1
fi

echo "==> Collecting a healthy baseline"
sleep $(( HEALTH_CHECK_INTERVAL_SECONDS * 2 + 5 ))

echo "==> Breaking the R2 <-> R3 link"
./lab/scenarios/01-link-failure.sh
sleep $(( HEALTH_CHECK_INTERVAL_SECONDS * 3 ))

echo "==> Restoring the network"
./lab/scenarios/03-restore-network.sh
sleep $(( HEALTH_CHECK_INTERVAL_SECONDS * 3 ))

cleanup

echo
echo "==================== HEALTH SERVICE OUTPUT ===================="
cat "${SERVICE_LOG}"
echo "==============================================================="
echo

echo "==> Asserting Firestore contents"
node scripts/assert-firestore.mjs
