#!/usr/bin/env bash
# SCENARIO 01 - R2 <-> R3 link failure
#
# Expected symptoms : R3 loopback unreachable, PC2 unreachable, PC1 cannot reach PC2
# Expected events   : device_unreachable for r3 and pc2
# Expected cause    : R2 eth2 (to-r3) administratively down
# Recovery          : ./lab/scenarios/03-restore-network.sh
#
# Repeatable: this only shuts an interface, it never rebuilds the lab.
set -euo pipefail

echo "==> Shutting down eth2 (to-r3) on R2"
docker exec clab-acn-r2 vtysh -c 'configure terminal' -c 'interface eth2' -c 'shutdown'

echo "==> R2 eth2 is now down. Expect r3 and pc2 to go unreachable within one check interval."
docker exec clab-acn-r2 vtysh -c 'show interface brief' | sed -n '1,12p'
