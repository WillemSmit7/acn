#!/usr/bin/env bash
# SCENARIO 03 - restore the network to a healthy baseline
#
# Undoes scenarios 01 and 02 without rebuilding the lab. Safe to run at any
# time, including when nothing is broken.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/docker.sh
source "${LAB_DIR}/lib/docker.sh"
resolve_docker || exit 2

echo "==> Starting any stopped lab containers"
restarted=0
for node in r1 r2 r3 pc1 pc2; do
  state="$(${DOCKER} inspect -f '{{.State.Running}}' "clab-acn-${node}" 2>/dev/null || echo missing)"
  case "${state}" in
    true)    ;;
    false)   echo "    starting clab-acn-${node}"; ${DOCKER} start "clab-acn-${node}" >/dev/null; restarted=1 ;;
    *)       echo "ERROR: container clab-acn-${node} does not exist - run ./lab/deploy.sh" >&2; exit 1 ;;
  esac
done

# A stopped container loses its containerlab veth pairs, and starting it back
# does NOT recreate them: the container comes up with only eth0 (management),
# FRR reads its config happily, and OSPF sits there with zero neighbours. That
# is exactly what scenario 02 does, so recovering from it needs a redeploy, not
# a container start. Only the links are rebuilt; the containers are reused.
if [ "${restarted}" -eq 1 ]; then
  echo "==> A container was restarted - recreating the data-plane links"
  echo "    (a stopped container loses its veth pairs; docker start does not restore them)"
  CLAB="containerlab"
  [ "${DOCKER}" = "sudo docker" ] && CLAB="sudo containerlab"
  ${CLAB} deploy --topo "${LAB_DIR}/topology.clab.yml" --reconfigure >/dev/null
fi

# FRR needs a moment after a container start before vtysh will answer.
echo "==> Waiting for FRR to accept vtysh commands"
for node in r1 r2 r3; do
  for _ in $(seq 1 30); do
    if ${DOCKER} exec "clab-acn-${node}" vtysh -c 'show version' >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
done

echo "==> Re-enabling all router data-plane interfaces"
restore_failed=0
for node in r1 r2 r3; do
  for iface in eth1 eth2; do
    if ! ${DOCKER} exec "clab-acn-${node}" vtysh \
        -c 'configure terminal' -c "interface ${iface}" -c 'no shutdown' >/dev/null 2>&1; then
      echo "    WARNING: could not re-enable ${iface} on ${node}" >&2
      restore_failed=1
    fi
  done
done

echo "==> Re-applying host addressing on PC1 / PC2 (no-op if already present)"
${DOCKER} exec clab-acn-pc1 sh -c \
  'ip address add 10.0.1.2/30 dev eth1 2>/dev/null; ip link set eth1 up;
   ip route add 10.0.0.0/16 via 10.0.1.1 2>/dev/null;
   ip route add 10.255.0.0/24 via 10.0.1.1 2>/dev/null; true'
${DOCKER} exec clab-acn-pc2 sh -c \
  'ip address add 10.0.3.2/30 dev eth1 2>/dev/null; ip link set eth1 up;
   ip route add 10.0.0.0/16 via 10.0.3.1 2>/dev/null;
   ip route add 10.255.0.0/24 via 10.0.3.1 2>/dev/null; true'

# Note this polls from the HOST, so it needs the routes deploy.sh installs.
# Without them it reports failure even when the lab itself is perfectly healthy.
echo "==> Waiting for OSPF to reconverge"
converged=0
for _ in $(seq 1 45); do
  if ping -c1 -W1 10.255.0.3 >/dev/null 2>&1; then converged=1; break; fi
  sleep 1
done

if [ "${converged}" -eq 1 ] && [ "${restore_failed}" -eq 0 ]; then
  echo "==> Network restored. Expect device_recovered events within one check interval."
else
  echo "ERROR: restore did not reach a healthy baseline (converged=${converged}, interface_errors=${restore_failed})." >&2
  echo "       Run ./lab/verify.sh to see what is still broken." >&2
  exit 1
fi
