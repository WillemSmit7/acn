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

echo "==> Removing the r3 CPU limit before restoring its control plane"
${DOCKER} update --cpu-quota -1 clab-acn-r3 >/dev/null

echo "==> Removing r3 resource pressure and restoring ospfd"
${DOCKER} exec clab-acn-r3 sh -c '
  if [ -s /tmp/acn-resource-pids ]; then
    while read -r pid; do kill "$pid" 2>/dev/null || true; done < /tmp/acn-resource-pids
    rm -f /tmp/acn-resource-pids
  fi
  if pidof ospfd >/dev/null 2>&1; then
    kill -CONT $(pidof ospfd) 2>/dev/null || true
  else
    rm -f /var/run/frr/ospfd.pid /var/run/frr/ospfd.vty
    /usr/lib/frr/watchfrr.sh start ospfd
  fi
  if [ -s /tmp/acn-watchfrr-stopped ]; then
    kill -CONT $(cat /tmp/acn-watchfrr-stopped) 2>/dev/null || true
    rm -f /tmp/acn-watchfrr-stopped
  fi
  for _ in $(seq 1 20); do
    pidof ospfd >/dev/null 2>&1 && exit 0
    sleep 1
  done
  echo "ERROR: ospfd did not restart after resuming watchfrr" >&2
  exit 1
'

missing_interfaces=()
for endpoint in r1:eth2 r2:eth1 r2:eth2 r3:eth1 r3:eth2 pc2:eth1; do
  node="${endpoint%%:*}"
  interface="${endpoint#*:}"
  if ! ${DOCKER} exec "clab-acn-${node}" ip link show "${interface}" >/dev/null 2>&1; then
    missing_interfaces+=("${node}:${interface}")
  fi
done

if [ "${#missing_interfaces[@]}" -gt 0 ]; then
  echo "ERROR: containerlab data-plane interfaces are missing: ${missing_interfaces[*]}" >&2
  echo "       From a terminal, run ./lab/deploy.sh --reconfigure to recreate them." >&2
  exit 1
fi

missing_routes=()
ip route show 10.255.0.0/24 | grep -q 'via 172.20.20.11' || missing_routes+=("10.255.0.0/24")
ip route show 10.0.0.0/16 | grep -q 'via 172.20.20.11' || missing_routes+=("10.0.0.0/16")
if [ "${#missing_routes[@]}" -gt 0 ]; then
  echo "ERROR: host routes into the lab are missing or incorrect: ${missing_routes[*]}" >&2
  echo "       From a terminal, run ./lab/deploy.sh --reconfigure to restore the routes." >&2
  exit 1
fi

echo "==> Waiting for R2, R3 and PC2 to become reachable"
reachable=false
stable_checks=0
deadline=$((SECONDS + 45))
while [ "${SECONDS}" -lt "${deadline}" ]; do
  if ${DOCKER} exec clab-acn-r3 vtysh -c 'show ip ospf neighbor' 2>/dev/null | grep -q 'Full/-' \
    && ping -c1 -W1 -n 10.255.0.2 >/dev/null 2>&1 \
    && ping -c1 -W1 -n 10.255.0.3 >/dev/null 2>&1 \
    && ping -c1 -W1 -n 10.0.3.2 >/dev/null 2>&1; then
    stable_checks=$((stable_checks + 1))
    if [ "${stable_checks}" -ge 3 ]; then
      reachable=true
      break
    fi
    sleep 5
  else
    stable_checks=0
    sleep 1
  fi
done

if [ "${reachable}" = false ]; then
  echo "ERROR: R2, R3 and PC2 did not all become reachable after 45 seconds." >&2
  echo "       Check the lab with ./lab/verify.sh; use ./lab/deploy.sh --reconfigure if links are stale." >&2
  exit 1
fi

echo "==> Baseline restored; R2, R3 and PC2 are reachable"
echo "==> The autonomous observer will emit recovery transitions"
