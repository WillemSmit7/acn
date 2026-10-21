# Starting and stopping ACN services from the end-to-end tests.
#
# Services are run as the BUILT artifact (node services/<name>/dist/index.js)
# rather than through `npx tsx`. That is not a style preference - it is the only
# way these tests can reliably stop what they started.
#
# `npx tsx src/index.ts` produces a four-deep chain:
#     npx -> npm exec -> sh -c tsx -> node
# Signalling the pid in $! kills the wrapper and orphans the node process, which
# keeps running and keeps writing to Firestore. Orphaned collectors have twice
# corrupted a run here: once leaving a Health Service emitting events 39 minutes
# after its test finished, and once leaving a second Incident Service fighting
# the first for the same INC-001 document. Every event type appearing exactly
# twice in the results is the signature of that bug.
#
# `node dist/index.js` is a single process. Killing its pid ends it.

# Build once before starting anything. Callers should invoke this first.
acn_build_services() {
  echo "==> Building services"
  npm run build --silent
}

# acn_start_service <dist-entrypoint> <logfile> -> prints the pid
acn_start_service() {
  local entrypoint="$1" logfile="$2"

  if [ ! -f "${entrypoint}" ]; then
    echo "ERROR: ${entrypoint} not found - run 'npm run build' first." >&2
    return 1
  fi

  node "${entrypoint}" > "${logfile}" 2>&1 &
  echo $!
}

# acn_stop_service <pid> - SIGTERM, wait for a clean drain, then insist.
acn_stop_service() {
  local pid="$1"
  [ -z "${pid}" ] && return 0
  kill -0 "${pid}" 2>/dev/null || return 0

  # The services drain buffered writes on SIGTERM, so give them time to finish
  # rather than killing mid-flush and losing the last events of a run.
  kill -TERM "${pid}" 2>/dev/null || true
  for _ in $(seq 1 40); do
    kill -0 "${pid}" 2>/dev/null || return 0
    sleep 0.25
  done

  echo "    WARNING: pid ${pid} did not exit on SIGTERM - killing" >&2
  kill -KILL "${pid}" 2>/dev/null || true
}

# Belt and braces: nothing matching an ACN service entrypoint may survive a
# test, whatever happened to the pids we were tracking.
acn_sweep_services() {
  local pattern='services/(health-service|layer-zero|incident-service|agent-service|lab-controller)/(dist/index\.js|src/index\.ts)|services/network-controller/(dist/main\.js|src/main\.ts)'
  local survivors
  survivors="$(pgrep -f "${pattern}" 2>/dev/null || true)"
  [ -z "${survivors}" ] && return 0

  echo "    WARNING: sweeping leftover service processes: ${survivors}" >&2
  # shellcheck disable=SC2086
  kill -KILL ${survivors} 2>/dev/null || true
}

# Fail loudly if a service died at startup, rather than 60 seconds later as a
# confusing assertion failure after the lab has been broken and restored.
# acn_require_alive <name> <pid> <logfile>
acn_require_alive() {
  local name="$1" pid="$2" logfile="$3"
  if kill -0 "${pid}" 2>/dev/null; then return 0; fi

  echo "ERROR: ${name} exited immediately after starting." >&2
  echo "----------------------- ${name} log -----------------------" >&2
  cat "${logfile}" >&2
  echo "-----------------------------------------------------------" >&2
  return 1
}
