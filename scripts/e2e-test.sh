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

cleanup() {
  if [ -n "${SERVICE_PID:-}" ] && kill -0 "${SERVICE_PID}" 2>/dev/null; then
    kill "${SERVICE_PID}" 2>/dev/null || true
    wait "${SERVICE_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Clearing previous emulator data"
./scripts/reset-firestore.sh

echo "==> Restoring the lab to a healthy baseline"
./lab/scenarios/03-restore-network.sh

echo "==> Starting the Health Service (interval ${HEALTH_CHECK_INTERVAL_SECONDS}s)"
npm run health-service --silent > "${SERVICE_LOG}" 2>&1 &
SERVICE_PID=$!

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
