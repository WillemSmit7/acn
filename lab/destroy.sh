#!/usr/bin/env bash
# Tear down the ACN lab and remove the host routes it added.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sudo containerlab destroy --topo "${LAB_DIR}/topology.clab.yml" --cleanup || true

sudo ip route del 10.255.0.0/24 2>/dev/null || true
sudo ip route del 10.0.0.0/16   2>/dev/null || true

echo "==> Lab destroyed and host routes removed."
