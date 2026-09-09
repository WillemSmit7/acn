#!/usr/bin/env bash
# ISP failure 2: logical OSPF session failure while the interface stays up.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${LAB_DIR}/lib/docker.sh"
source "${LAB_DIR}/lib/failure-observer.sh"
resolve_docker || exit 2
require_router r2

echo "==> Making r2 eth2 passive in OSPF (physical interface remains up)"
${DOCKER} exec clab-acn-r2 vtysh \
  -c 'configure terminal' -c 'router ospf' -c 'passive-interface eth2'

running="$(${DOCKER} exec clab-acn-r2 vtysh -c 'show running-config')"
grep -q 'passive-interface eth2' <<<"${running}"
emit_monitor_event r2 routing_session_down \
  protocol=ospf interface=eth2 peer=10.255.0.3 cause=passive_interface interfaceState=up
echo "==> Probe confirmed a logical OSPF-session fault with eth2 still enabled"
