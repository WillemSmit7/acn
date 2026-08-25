#!/usr/bin/env bash
# Deploy the ACN lab topology and wire the host into the lab data plane.
#
# The Health Service pings router LOOPBACKS (10.255.0.0/24) and host addresses
# (10.0.0.0/16). Those are only reachable through the emulated data plane, which
# is exactly what makes a link failure visible to the Health Service. Management
# addresses (172.20.20.0/24) stay reachable at all times and are used for vtysh.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOPOLOGY="${LAB_DIR}/topology.clab.yml"
GATEWAY="172.20.20.11"   # r1 management address = host's way into the data plane

command -v containerlab >/dev/null 2>&1 || {
  echo "ERROR: containerlab is not installed. Run ./lab/install-prereqs.sh first." >&2
  exit 1
}

echo "==> Deploying containerlab topology"
sudo containerlab deploy --topo "${TOPOLOGY}" --reconfigure

echo "==> Adding host routes into the lab data plane (via r1 @ ${GATEWAY})"
sudo ip route replace 10.255.0.0/24 via "${GATEWAY}"
sudo ip route replace 10.0.0.0/16   via "${GATEWAY}"

echo "==> Waiting for OSPF to converge"
for _ in $(seq 1 30); do
  if ping -c1 -W1 10.255.0.3 >/dev/null 2>&1; then
    echo "    OSPF converged - r3 loopback reachable from host"
    break
  fi
  sleep 1
done

echo
echo "==> Lab is up. Verify with:  ./lab/verify.sh"
