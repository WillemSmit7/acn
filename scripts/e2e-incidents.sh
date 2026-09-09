#!/usr/bin/env bash
# ACN Increment 3 end-to-end test.
#
# Runs the whole stack - Health Service, Layer 0 and the Incident Service -
# against the real lab through all five ISP-style fault categories. This is the
# slower live-lab counterpart to the credit-free focused fixture E2E.
#
# Prerequisites (already running in other terminals):
#   ./lab/deploy.sh
#   firebase emulators:start
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# shellcheck source=../lab/lib/docker.sh
source "${REPO_ROOT}/lab/lib/docker.sh"
# shellcheck source=lib/services.sh
source "${REPO_ROOT}/scripts/lib/services.sh"
resolve_docker || exit 2

export FIRESTORE_EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8080}"
export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-acn-local}"
export HEALTH_CHECK_INTERVAL_SECONDS="${HEALTH_CHECK_INTERVAL_SECONDS:-5}"
export HEALTH_CHECK_TIMEOUT_SECONDS=2
export INCIDENT_SETTLE_MS="${INCIDENT_SETTLE_MS:-8000}"
export LOG_LEVEL=info

HEALTH_LOG="$(mktemp -t acn-health-XXXXXX.log)"
LAYER_ZERO_LOG="$(mktemp -t acn-layer0-XXXXXX.log)"
INCIDENT_LOG="$(mktemp -t acn-incident-XXXXXX.log)"
HEALTH_PID=""
LAYER_ZERO_PID=""
INCIDENT_PID=""

cleanup() {
  acn_stop_service "${INCIDENT_PID}"
  acn_stop_service "${LAYER_ZERO_PID}"
  acn_stop_service "${HEALTH_PID}"
  acn_sweep_services
}
trap cleanup EXIT

acn_build_services

# Nothing from an earlier run may still be writing while this one asserts.
acn_sweep_services

echo "==> Clearing previous emulator data"
./scripts/reset-firestore.sh

echo "==> Restoring the lab to a healthy baseline"
./lab/scenarios/06-restore-network.sh

echo "==> Starting Layer 0, the Health Service and the Incident Service"
LAYER_ZERO_PID="$(acn_start_service services/layer-zero/dist/index.js "${LAYER_ZERO_LOG}")"
HEALTH_PID="$(acn_start_service services/health-service/dist/index.js "${HEALTH_LOG}")"
INCIDENT_PID="$(acn_start_service services/incident-service/dist/index.js "${INCIDENT_LOG}")"

sleep 6
acn_require_alive "Layer 0" "${LAYER_ZERO_PID}" "${LAYER_ZERO_LOG}"
acn_require_alive "Health Service" "${HEALTH_PID}" "${HEALTH_LOG}"
acn_require_alive "Incident Service" "${INCIDENT_PID}" "${INCIDENT_LOG}"

echo "==> Collecting a healthy baseline"
sleep 12

for scenario in \
  01-configuration-drift \
  02-routing-session-failure \
  03-interface-disabled \
  04-routing-service-crash \
  05-resource-exhaustion; do
  echo
  echo "==> Running ${scenario}"
  "./lab/scenarios/${scenario}.sh"
  sleep 35
  echo "==> Restoring the network"
  ./lab/scenarios/06-restore-network.sh
  sleep 45
done

cleanup

echo
echo "==================== INCIDENT SERVICE ===================="
cat "${INCIDENT_LOG}"
echo "========================================================="
echo

echo "==> Asserting Firestore contents"
node scripts/assert-incidents.mjs
