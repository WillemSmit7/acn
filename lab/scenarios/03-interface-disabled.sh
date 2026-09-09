#!/usr/bin/env bash
# ISP failure 3: administratively disabled interface / logical port error.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${LAB_DIR}/lib/docker.sh"
source "${LAB_DIR}/lib/failure-observer.sh"
resolve_docker || exit 2
require_router r2

echo "==> Administratively shutting r2 eth2"
${DOCKER} exec clab-acn-r2 vtysh \
  -c 'configure terminal' -c 'interface eth2' -c 'shutdown'

running="$(${DOCKER} exec clab-acn-r2 vtysh -c 'show running-config')"
grep -A8 '^interface eth2' <<<"${running}" | grep -q 'shutdown'
emit_monitor_event r2 interface_admin_down \
  interface=eth2 peer=r3 adminState=down expectedState=up
echo "==> Probe confirmed r2 eth2 is administratively disabled"
