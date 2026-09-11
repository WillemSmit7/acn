#!/usr/bin/env bash
# Restore every requested ISP failure scenario to the intended baseline.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${LAB_DIR}/lib/docker.sh"
source "${LAB_DIR}/lib/failure-observer.sh"
resolve_docker || exit 2
require_router r2
require_router r3

echo "==> Restoring r2 interface and OSPF configuration"
${DOCKER} exec clab-acn-r2 vtysh \
  -c 'configure terminal' \
  -c 'interface eth2' -c 'no shutdown' -c 'no ip ospf cost' \
  -c 'router ospf' -c 'no passive-interface eth2'

echo "==> Removing r3 resource pressure and restoring ospfd"
${DOCKER} exec clab-acn-r3 sh -c '
  if [ -s /tmp/acn-resource-pids ]; then
    while read -r pid; do kill "$pid" 2>/dev/null || true; done < /tmp/acn-resource-pids
    rm -f /tmp/acn-resource-pids
  fi
  if pidof ospfd >/dev/null 2>&1; then kill -CONT $(pidof ospfd) 2>/dev/null || true; fi
  if [ -s /tmp/acn-watchfrr-stopped ]; then
    kill -CONT $(cat /tmp/acn-watchfrr-stopped) 2>/dev/null || true
    rm -f /tmp/acn-watchfrr-stopped
  fi
  sleep 2
  if ! pidof ospfd >/dev/null 2>&1; then /usr/lib/frr/frrinit.sh restart; fi
'
${DOCKER} update --cpus 0 clab-acn-r3 >/dev/null

echo "==> Baseline restored; the autonomous observer will emit recovery transitions"
echo "==> Allow OSPF one dead interval to reconverge"
