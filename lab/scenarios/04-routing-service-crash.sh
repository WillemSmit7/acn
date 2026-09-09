#!/usr/bin/env bash
# ISP failure 4: ospfd stops while the router/container remains alive.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${LAB_DIR}/lib/docker.sh"
source "${LAB_DIR}/lib/failure-observer.sh"
resolve_docker || exit 2
require_router r3

echo "==> Suspending FRR watchdog and stopping ospfd on r3"
${DOCKER} exec clab-acn-r3 sh -c '
  watch=$(pidof watchfrr)
  kill -STOP "$watch"
  echo "$watch" > /tmp/acn-watchfrr-stopped
  kill -9 $(pidof ospfd)
'

if ${DOCKER} exec clab-acn-r3 pidof ospfd >/dev/null 2>&1; then
  echo "ERROR: ospfd is still running" >&2
  exit 1
fi
emit_monitor_event r3 routing_service_down \
  service=ospfd processState=stopped containerState=running
echo "==> Probe confirmed ospfd stopped while r3 remained running"
