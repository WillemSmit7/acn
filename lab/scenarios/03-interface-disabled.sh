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

echo "==> Fault injected; the autonomous observer will detect the administrative state"
