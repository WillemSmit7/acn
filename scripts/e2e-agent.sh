#!/usr/bin/env bash
# ACN Increment 4 end-to-end test: real lab evidence -> incidents -> GPT-5.6 Luna.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: OPENAI_API_KEY is not set. Load services/agent-service/.env first." >&2
  exit 2
fi

# shellcheck source=lib/services.sh
source "${REPO_ROOT}/scripts/lib/services.sh"

export FIRESTORE_EMULATOR_HOST="${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8080}"
export FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-acn-local}"
export OPENAI_REASONING_EFFORT=low
export LOG_LEVEL=info

AGENT_LOG="$(mktemp -t acn-agent-XXXXXX.log)"
AGENT_PID=""

cleanup() {
  acn_stop_service "${AGENT_PID}"
  acn_sweep_services
}
trap cleanup EXIT

# This produces the two real, deliberately confusable incidents and leaves them
# in Firestore after stopping the lower services.
./scripts/e2e-incidents.sh

echo "==> Starting GPT-5.6 Luna Agent Service"
AGENT_PID="$(acn_start_service services/agent-service/dist/index.js "${AGENT_LOG}")"
sleep 2
acn_require_alive "Agent Service" "${AGENT_PID}" "${AGENT_LOG}"

echo "==> Waiting for five investigations"
node scripts/wait-agent-runs.mjs 5 180000
cleanup

echo
echo "====================== AGENT SERVICE ====================="
cat "${AGENT_LOG}"
echo "=========================================================="
echo

node scripts/assert-agent.mjs
