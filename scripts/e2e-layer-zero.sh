#!/usr/bin/env bash
# ACN Increment 2 end-to-end test.
#
# Runs the Health Service and Layer 0 together against the real lab:
#   healthy baseline -> break R2-R3 -> observe -> restore -> observe
# then reads Firestore back and asserts that raw logs were captured, normalized
# into events, and that every event traces back to the line it came from.
#
# Both services write into networkEvents/ - the Health Service from ICMP, Layer
# 0 from device logs - which is exactly the mixed stream Increment 3 correlates.
#
# Prerequisites (already running in other terminals):
#   ./lab/deploy.sh
#   firebase emulators:start
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# Fail before starting anything if Docker is unreachable: Layer 0 reads the
# router logs through 'docker exec'.
# shellcheck source=../lab/lib/docker.sh
source "${REPO_ROOT}/lab/lib/docker.sh"
resolve_docker || exit 2

export FIRESTORE_EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8080}"
export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-acn-local}"
export HEALTH_CHECK_INTERVAL_SECONDS="${HEALTH_CHECK_INTERVAL_SECONDS:-5}"
export HEALTH_CHECK_TIMEOUT_SECONDS=2
export LOG_LEVEL=info

HEALTH_LOG="$(mktemp -t acn-health-XXXXXX.log)"
LAYER_ZERO_LOG="$(mktemp -t acn-layer0-XXXXXX.log)"
HEALTH_PID=""
LAYER_ZERO_PID=""

# Each service is started with setsid so it leads its own process group, and is
# stopped by signalling that whole group. Signalling only the pid leaves the
# actual node process orphaned and still writing to Firestore, which silently
# corrupts any later run - that is not hypothetical, it happened during
# Increment 2 development.
start_service() {
  local entrypoint="$1" logfile="$2"
  setsid npx tsx "${entrypoint}" > "${logfile}" 2>&1 &
  echo $!
}

stop_service() {
  local pid="$1"
  [ -z "${pid}" ] && return 0
  kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
  # Give a SIGTERM handler a moment to drain buffered writes before insisting.
  for _ in $(seq 1 20); do
    kill -0 "${pid}" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -KILL "-${pid}" 2>/dev/null || true
}

cleanup() {
  stop_service "${LAYER_ZERO_PID}"
  stop_service "${HEALTH_PID}"
}
trap cleanup EXIT

alive() { kill -0 "$1" 2>/dev/null; }

echo "==> Clearing previous emulator data"
./scripts/reset-firestore.sh

echo "==> Restoring the lab to a healthy baseline"
./lab/scenarios/03-restore-network.sh

echo "==> Starting Layer 0"
LAYER_ZERO_PID="$(start_service services/layer-zero/src/index.ts "${LAYER_ZERO_LOG}")"

echo "==> Starting the Health Service (interval ${HEALTH_CHECK_INTERVAL_SECONDS}s)"
HEALTH_PID="$(start_service services/health-service/src/index.ts "${HEALTH_LOG}")"

# A service that dies at startup must surface here, not 45 seconds later as a
# confusing assertion failure after the lab has been broken and restored.
sleep 5
for entry in "Layer 0:${LAYER_ZERO_PID}:${LAYER_ZERO_LOG}" "Health Service:${HEALTH_PID}:${HEALTH_LOG}"; do
  name="${entry%%:*}"; rest="${entry#*:}"; pid="${rest%%:*}"; logfile="${rest#*:}"
  if ! alive "${pid}"; then
    echo "ERROR: ${name} exited immediately after starting." >&2
    echo "----------------------- ${name} log -----------------------" >&2
    cat "${logfile}" >&2
    echo "-----------------------------------------------------------" >&2
    exit 1
  fi
done

echo "==> Collecting a healthy baseline"
sleep $(( HEALTH_CHECK_INTERVAL_SECONDS * 2 + 5 ))

echo "==> Breaking the R2 <-> R3 link"
./lab/scenarios/01-link-failure.sh
sleep $(( HEALTH_CHECK_INTERVAL_SECONDS * 3 ))

echo "==> Restoring the network"
./lab/scenarios/03-restore-network.sh
# OSPF needs longer to re-establish an adjacency than ICMP needs to recover, so
# this wait is deliberately more generous than the Increment 1 test's.
sleep $(( HEALTH_CHECK_INTERVAL_SECONDS * 4 ))

cleanup

echo
echo "==================== LAYER 0 OUTPUT ===================="
cat "${LAYER_ZERO_LOG}"
echo "================== HEALTH SERVICE OUTPUT ==============="
cat "${HEALTH_LOG}"
echo "========================================================"
echo

echo "==> Asserting Firestore contents"
node scripts/assert-layer-zero.mjs
