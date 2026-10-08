#!/usr/bin/env bash
# ISP failure 5: bounded CPU exhaustion starves the OSPF control plane.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${LAB_DIR}/lib/docker.sh"
source "${LAB_DIR}/lib/failure-observer.sh"
resolve_docker || exit 2
require_router r3

echo "==> Constraining r3 CPU and starting bounded control-plane pressure"
${DOCKER} update --cpu-period 100000 --cpu-quota 10000 clab-acn-r3 >/dev/null
${DOCKER} exec clab-acn-r3 sh -c '
  : > /tmp/acn-resource-pids
  watch=$(pidof watchfrr)
  kill -STOP "$watch"
  echo "$watch" > /tmp/acn-watchfrr-stopped
  kill -STOP $(pidof ospfd)
  for _worker in 1 2 3 4; do
    nice -n 19 yes > /dev/null &
    echo $! >> /tmp/acn-resource-pids
  done
'

echo "==> Fault injected; the autonomous observer will detect the quota and stopped service"
