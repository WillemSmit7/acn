#!/usr/bin/env bash
# Start the complete ACN local operator stack and keep ownership of its processes.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ACN_RUNTIME_DIR:-${REPO_ROOT}/.acn-runtime}"
LOG_DIR="${RUNTIME_DIR}/logs"
LOCK_DIR="${RUNTIME_DIR}/running"
PROJECT_ID="acn-local"
EMULATOR_HOST="127.0.0.1:8080"
STARTED_PIDS=()
STARTED_NAMES=()
STOPPING=0

cd "${REPO_ROOT}"

usage() {
  cat <<'EOF'
Usage: npm run start:all

Starts the lab, Firestore emulator, Health Service, Layer Zero, Incident
Service, GPT Agent Service, local Lab Controller, guarded Network Controller
and Angular visualizer.

Environment overrides:
  ACN_WEB_PORT=4300       choose the dashboard port (default: first free 4200+)
  ACN_OPEN_BROWSER=0      do not open the dashboard automatically
  ACN_SKIP_AGENT=1        start without Luna (useful before configuring a key)
  ACN_SKIP_LAB=1          do not verify/deploy Containerlab
  ACN_SKIP_BUILD=1        use existing dist/ artifacts

Press Ctrl+C to stop every process started by this command. Logs are retained
under .acn-runtime/logs/.
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi
if [ "$#" -ne 0 ]; then
  usage >&2
  exit 2
fi

mkdir -p "${LOG_DIR}"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  previous_pid="$(sed -n '1p' "${LOCK_DIR}/pid" 2>/dev/null || true)"
  if [ -n "${previous_pid}" ] && kill -0 "${previous_pid}" 2>/dev/null; then
    echo "ACN is already managed by start-all.sh (pid ${previous_pid})." >&2
    echo "Use that terminal or press Ctrl+C there before starting another stack." >&2
    exit 1
  fi
  rm -f "${LOCK_DIR}/pid"
  rmdir "${LOCK_DIR}" 2>/dev/null || true
  mkdir "${LOCK_DIR}"
fi
echo "$$" > "${LOCK_DIR}/pid"

cleanup() {
  [ "${STOPPING}" -eq 1 ] && return
  STOPPING=1
  trap - EXIT INT TERM
  echo
  echo "==> Stopping ACN processes started by this launcher"
  local index pid
  for ((index=${#STARTED_PIDS[@]}-1; index>=0; index--)); do
    pid="${STARTED_PIDS[index]}"
    echo "    ${STARTED_NAMES[index]} (pid ${pid})"
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
  done
  for pid in "${STARTED_PIDS[@]}"; do
    wait "${pid}" 2>/dev/null || true
  done
  rm -f "${LOCK_DIR}/pid"
  rmdir "${LOCK_DIR}" 2>/dev/null || true
  echo "==> ACN stopped. Logs remain in ${LOG_DIR}"
}
handle_signal() {
  cleanup
  exit 130
}
trap cleanup EXIT
trap handle_signal INT TERM

port_open() {
  local port="$1"
  curl --silent --show-error --max-time 1 --output /dev/null "http://127.0.0.1:${port}/" 2>/dev/null
}

is_acn_controller() {
  curl --silent --show-error --max-time 1 "http://127.0.0.1:8787/api/status" 2>/dev/null |
    grep -q '"configuration-drift"'
}

is_acn_visualizer() {
  local port="$1"
  curl --silent --show-error --max-time 1 "http://127.0.0.1:${port}/" 2>/dev/null |
    grep -q '<title>ACN NOC</title>'
}

is_acn_network_controller() {
  curl --silent --show-error --max-time 1 "http://127.0.0.1:8788/api/status" 2>/dev/null |
    grep -q '"adapters"'
}

wait_for_port() {
  local name="$1" port="$2" attempts="${3:-60}"
  local attempt
  for ((attempt=1; attempt<=attempts; attempt++)); do
    port_open "${port}" && return 0
    sleep 0.5
  done
  echo "ERROR: ${name} did not open port ${port}." >&2
  return 1
}

start_in_dir() {
  local name="$1" directory="$2"
  shift 2
  local logfile="${LOG_DIR}/${name}.log"
  : > "${logfile}"
  (
    cd "${directory}"
    exec setsid "$@"
  ) > "${logfile}" 2>&1 &
  local pid=$!
  STARTED_PIDS+=("${pid}")
  STARTED_NAMES+=("${name}")
  echo "    ${name} (pid ${pid}, log ${logfile})"
}

require_agent_key() {
  [ "${ACN_SKIP_AGENT:-0}" = "1" ] && return 0
  [ -n "${OPENAI_API_KEY:-}" ] && return 0
  local env_file="${REPO_ROOT}/services/agent-service/.env"
  if [ -f "${env_file}" ] &&
      grep -Eq '^OPENAI_API_KEY=.+$' "${env_file}" &&
      ! grep -Eq '^OPENAI_API_KEY=.*sk-your-openai-api-key-here' "${env_file}"; then
    return 0
  fi
  echo "ERROR: Luna needs OPENAI_API_KEY." >&2
  echo "Either export it in this terminal, or run:" >&2
  echo "  cp services/agent-service/.env.example services/agent-service/.env" >&2
  echo "and put the key in that gitignored file." >&2
  echo "To start the rest without Luna, use ACN_SKIP_AGENT=1 npm run start:all" >&2
  return 1
}

require_agent_key

if [ "${ACN_SKIP_BUILD:-0}" != "1" ]; then
  echo "==> Building services and visualizer"
  npm run build --silent
fi

if [ "${ACN_SKIP_LAB:-0}" != "1" ]; then
  echo "==> Checking the Containerlab network"
  if ./lab/verify.sh > "${LOG_DIR}/lab-verify.log" 2>&1; then
    echo "    lab already healthy"
  else
    echo "    lab is absent or unhealthy; deploying a clean baseline"
    ./lab/deploy.sh
  fi
fi

export FIRESTORE_EMULATOR_HOST="${EMULATOR_HOST}"
export FIREBASE_PROJECT_ID="${PROJECT_ID}"

echo "==> Starting Firestore emulator"
if port_open 8080; then
  echo "    reusing emulator already on 127.0.0.1:8080"
else
  start_in_dir "emulators" "${REPO_ROOT}" npm run emulators
  wait_for_port "Firestore emulator" 8080 120 || {
    tail -n 40 "${LOG_DIR}/emulators.log" >&2
    exit 1
  }
fi

echo "==> Starting telemetry and investigation services"
start_in_dir "health-service" "${REPO_ROOT}/services/health-service" node dist/index.js
start_in_dir "layer-zero" "${REPO_ROOT}/services/layer-zero" node dist/index.js
start_in_dir "incident-service" "${REPO_ROOT}/services/incident-service" node dist/index.js
if [ "${ACN_SKIP_AGENT:-0}" != "1" ]; then
  start_in_dir "agent-service" "${REPO_ROOT}/services/agent-service" node dist/index.js
else
  echo "    agent-service skipped (ACN_SKIP_AGENT=1)"
fi

if port_open 8787; then
  if is_acn_controller; then
    echo "    reusing Lab Controller already on 127.0.0.1:8787"
  else
    echo "ERROR: port 8787 is occupied by something other than the ACN Lab Controller." >&2
    exit 1
  fi
else
  start_in_dir "lab-controller" "${REPO_ROOT}/services/lab-controller" node dist/index.js
  wait_for_port "Lab Controller" 8787 30 || {
    tail -n 40 "${LOG_DIR}/lab-controller.log" >&2
    exit 1
  }
fi

if port_open 8788; then
  if is_acn_network_controller; then
    echo "    reusing Network Controller already on 127.0.0.1:8788"
  else
    echo "ERROR: port 8788 is occupied by something other than the ACN Network Controller." >&2
    exit 1
  fi
else
  start_in_dir "network-controller" "${REPO_ROOT}/services/network-controller" node dist/main.js
  wait_for_port "Network Controller" 8788 30 || {
    tail -n 40 "${LOG_DIR}/network-controller.log" >&2
    exit 1
  }
fi

web_port="${ACN_WEB_PORT:-}"
reuse_web=0
if [ -n "${web_port}" ]; then
  if port_open "${web_port}"; then
    if is_acn_visualizer "${web_port}"; then
      reuse_web=1
    else
      echo "ERROR: ACN_WEB_PORT ${web_port} is already used by another application." >&2
      exit 1
    fi
  fi
else
  for candidate in $(seq 4200 4299); do
    if port_open "${candidate}" && is_acn_visualizer "${candidate}"; then
      web_port="${candidate}"
      reuse_web=1
      break
    fi
  done
fi
if [ -z "${web_port}" ]; then
  for candidate in $(seq 4200 4299); do
    if ! port_open "${candidate}"; then
      web_port="${candidate}"
      break
    fi
  done
fi
if [ -z "${web_port}" ]; then
  echo "ERROR: no free dashboard port found in 4200-4299." >&2
  exit 1
fi

if [ "${reuse_web}" -eq 1 ]; then
  echo "    reusing ACN visualizer already on 127.0.0.1:${web_port}"
else
  start_in_dir "visualizer" "${REPO_ROOT}/apps/web" "${REPO_ROOT}/node_modules/.bin/ng" serve --port "${web_port}"
  wait_for_port "Angular visualizer" "${web_port}" 120 || {
    tail -n 40 "${LOG_DIR}/visualizer.log" >&2
    exit 1
  }
fi

sleep 2
for index in "${!STARTED_PIDS[@]}"; do
  pid="${STARTED_PIDS[index]}"
  if ! kill -0 "${pid}" 2>/dev/null; then
    echo "ERROR: ${STARTED_NAMES[index]} exited during startup." >&2
    tail -n 40 "${LOG_DIR}/${STARTED_NAMES[index]}.log" >&2
    exit 1
  fi
done

dashboard_url="http://localhost:${web_port}"
echo
echo "============================================================"
echo " ACN operator stack is ready"
echo " Dashboard:        ${dashboard_url}"
echo " Firebase UI:      http://localhost:4000"
echo " Lab Controller:   http://127.0.0.1:8787"
echo " Network Controller:http://127.0.0.1:8788"
echo " Logs:             ${LOG_DIR}"
echo "============================================================"
echo "Use the dashboard buttons to break/restore the lab."
echo "Press Ctrl+C here to stop the processes started by this command."

if [ "${ACN_OPEN_BROWSER:-1}" != "0" ] && command -v xdg-open >/dev/null 2>&1 &&
    { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
  xdg-open "${dashboard_url}" >/dev/null 2>&1 &
fi

while true; do
  sleep 2
  for index in "${!STARTED_PIDS[@]}"; do
    pid="${STARTED_PIDS[index]}"
    if ! kill -0 "${pid}" 2>/dev/null; then
      echo "ERROR: ${STARTED_NAMES[index]} stopped unexpectedly." >&2
      tail -n 40 "${LOG_DIR}/${STARTED_NAMES[index]}.log" >&2
      exit 1
    fi
  done
done
