#!/usr/bin/env bash
# SCENARIO 02 - complete R3 router failure
#
# Expected symptoms : R3 loopback unreachable, PC2 unreachable
# Expected events   : device_unreachable for r3 and pc2
# Expected cause    : R3 node down
# Recovery          : ./lab/scenarios/03-restore-network.sh
#
# Repeatable: the container is stopped, not deleted, so it can be started again.
set -euo pipefail

echo "==> Stopping the R3 container"
docker stop clab-acn-r3 >/dev/null

echo "==> R3 is down. Expect r3 and pc2 to go unreachable within one check interval."
