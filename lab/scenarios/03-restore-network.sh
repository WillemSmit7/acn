#!/usr/bin/env bash
# SCENARIO 03 - restore the network to a healthy baseline
#
# Undoes scenarios 01 and 02 without rebuilding the lab. Safe to run at any time,
# including when nothing is broken.
set -euo pipefail

echo "==> Starting any stopped lab containers"
for node in r1 r2 r3 pc1 pc2; do
  if [ "$(docker inspect -f '{{.State.Running}}' "clab-acn-${node}" 2>/dev/null)" = "false" ]; then
    echo "    starting clab-acn-${node}"
    docker start "clab-acn-${node}" >/dev/null
  fi
done

echo "==> Re-enabling all router data-plane interfaces"
for node in r1 r2 r3; do
  for iface in eth1 eth2; do
    docker exec "clab-acn-${node}" vtysh \
      -c 'configure terminal' -c "interface ${iface}" -c 'no shutdown' >/dev/null 2>&1 || true
  done
done

echo "==> Re-applying host addressing on PC1 / PC2 (no-op if already present)"
docker exec clab-acn-pc1 sh -c \
  'ip address add 10.0.1.2/30 dev eth1 2>/dev/null; ip link set eth1 up;
   ip route add 10.0.0.0/16 via 10.0.1.1 2>/dev/null;
   ip route add 10.255.0.0/24 via 10.0.1.1 2>/dev/null; true'
docker exec clab-acn-pc2 sh -c \
  'ip address add 10.0.3.2/30 dev eth1 2>/dev/null; ip link set eth1 up;
   ip route add 10.0.0.0/16 via 10.0.3.1 2>/dev/null;
   ip route add 10.255.0.0/24 via 10.0.3.1 2>/dev/null; true'

echo "==> Waiting for OSPF to reconverge"
for _ in $(seq 1 30); do
  if ping -c1 -W1 10.255.0.3 >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "==> Network restored. Expect device_recovered events within one check interval."
