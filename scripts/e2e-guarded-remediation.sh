#!/usr/bin/env bash
# Increment 6 live-lab vertical slice using a deterministic completed-run fixture.
# Prerequisites: deployed lab and Firestore emulator.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
source "${REPO_ROOT}/lab/lib/docker.sh"
source "${REPO_ROOT}/scripts/lib/services.sh"
resolve_docker || exit 2

export FIRESTORE_EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8080}"
export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-acn-local}"
export LAYER_ZERO_OBSERVER_INTERVAL_MS=1000
export INCIDENT_SETTLE_MS=3000
export INCIDENT_TICK_INTERVAL_MS=500
export NETWORK_VERIFY_TIMEOUT_MS=60000
export NETWORK_VERIFY_POLL_MS=500

LAYER_LOG="$(mktemp -t acn-layer0-remediation-XXXXXX.log)"
INCIDENT_LOG="$(mktemp -t acn-incident-remediation-XXXXXX.log)"
CONTROLLER_LOG="$(mktemp -t acn-network-controller-XXXXXX.log)"
LAYER_PID="" INCIDENT_PID="" CONTROLLER_PID=""

cleanup() {
  ./lab/scenarios/06-restore-network.sh >/dev/null 2>&1 || true
  acn_stop_service "${CONTROLLER_PID}"
  acn_stop_service "${INCIDENT_PID}"
  acn_stop_service "${LAYER_PID}"
  acn_sweep_services
}
trap cleanup EXIT

acn_build_services
acn_sweep_services
./scripts/reset-firestore.sh
./lab/scenarios/06-restore-network.sh

LAYER_PID="$(acn_start_service services/layer-zero/dist/index.js "${LAYER_LOG}")"
INCIDENT_PID="$(acn_start_service services/incident-service/dist/index.js "${INCIDENT_LOG}")"
CONTROLLER_PID="$(acn_start_service services/network-controller/dist/main.js "${CONTROLLER_LOG}")"
sleep 4
acn_require_alive "Layer 0" "${LAYER_PID}" "${LAYER_LOG}"
acn_require_alive "Incident Service" "${INCIDENT_PID}" "${INCIDENT_LOG}"
acn_require_alive "Network Controller" "${CONTROLLER_PID}" "${CONTROLLER_LOG}"

for specification in \
  '01-configuration-drift:restore_ospf_cost:configuration_drift:configuration_drift' \
  '02-routing-session-failure:restore_ospf_adjacency:routing_session_failure:routing_session_down' \
  '03-interface-disabled:enable_interface:interface_misconfiguration:interface_admin_down' \
  '04-routing-service-crash:restart_routing_service:routing_service_failure:routing_service_down' \
  '05-resource-exhaustion:restore_resource_profile:resource_exhaustion:resource_exhaustion'; do
  IFS=: read -r scenario tool cause fault_event <<< "${specification}"
  echo "==> Injecting ${scenario}"
  "./lab/scenarios/${scenario}.sh"
  echo "==> Approving validated ${tool} fixture through the API"
  EXPECTED_REMEDIATION_TOOL="${tool}" \
    EXPECTED_ROOT_CAUSE="${cause}" \
    EXPECTED_FAULT_EVENT="${fault_event}" \
    node scripts/e2e-guarded-remediation.mjs
  sleep 5
done
