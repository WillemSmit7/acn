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
ROUTES=("10.255.0.0/24" "10.0.0.0/16")

source "${LAB_DIR}/lib/docker.sh"

command -v containerlab >/dev/null 2>&1 || {
  echo "ERROR: containerlab is not installed. Run ./lab/install-prereqs.sh first." >&2
  exit 1
}

# Fails loudly with actionable guidance if the daemon is unreachable, rather
# than letting containerlab report a confusing raw socket error.
resolve_docker

# containerlab installs itself setuid root, so it needs no sudo once the docker
# socket is reachable as the invoking user. Only fall back to sudo when it is not.
CLAB="containerlab"
[ "${DOCKER}" = "sudo docker" ] && CLAB="sudo containerlab"

echo "==> Deploying containerlab topology"
${CLAB} deploy --topo "${TOPOLOGY}" --reconfigure

# Adding routes needs root. Skip the sudo prompt entirely when they are already
# correct, so re-running deploy on an existing lab is non-interactive.
routes_present() {
  local route
  for route in "${ROUTES[@]}"; do
    ip route show "${route}" 2>/dev/null | grep -q "via ${GATEWAY}" || return 1
  done
  return 0
}

if routes_present; then
  echo "==> Host routes into the data plane already present"
else
  echo "==> Adding host routes into the lab data plane (via r1 @ ${GATEWAY})"
  echo "    This needs root - sudo may prompt for your password."
  for route in "${ROUTES[@]}"; do
    sudo ip route replace "${route}" via "${GATEWAY}"
  done
fi

echo "==> Waiting for OSPF to converge"
converged=false
for _ in $(seq 1 30); do
  if ping -c1 -W1 10.255.0.3 >/dev/null 2>&1; then
    echo "    OSPF converged - r3 loopback reachable from host"
    converged=true
    break
  fi
  sleep 1
done

if [ "${converged}" = false ]; then
  echo "WARNING: r3 loopback still unreachable after 30s." >&2
  echo "         Check './lab/verify.sh' and 'containerlab inspect --all'." >&2
  exit 1
fi

echo
echo "==> Lab is up. Verify with:  ./lab/verify.sh"
