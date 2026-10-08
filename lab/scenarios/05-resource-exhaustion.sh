#!/usr/bin/env bash
# ISP failure 5: bounded CPU exhaustion starves the OSPF control plane.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${LAB_DIR}/lib/docker.sh"
source "${LAB_DIR}/lib/failure-observer.sh"
resolve_docker || exit 2
require_router r3

echo "==> Constraining r3 CPU and starting bounded control-plane pressure"
# Set up and record the fault before throttling R3: applying the quota first
# also starved this setup shell, so it could stall or exit before tracking cleanup.
${DOCKER} exec clab-acn-r3 sh -c '
  set -eu
  : > /tmp/acn-resource-pids
  watch=$(pidof watchfrr)
  ospfd=$(pidof ospfd)
  kill -STOP "$watch"
  echo "$watch" > /tmp/acn-watchfrr-stopped
  kill -STOP "$ospfd"
  for _worker in 1 2 3 4; do
    # Close both inherited pipes so background workers cannot hold docker exec open.
    nice -n 19 yes > /dev/null 2>&1 &
    echo $! >> /tmp/acn-resource-pids
  done
'
${DOCKER} update --cpu-period 100000 --cpu-quota 10000 clab-acn-r3 >/dev/null

echo "==> Fault injected; the autonomous observer will detect the quota and stopped service"
