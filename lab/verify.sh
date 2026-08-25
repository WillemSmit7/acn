#!/usr/bin/env bash
# Prove the topology works: end-to-end host connectivity and hop-by-hop links.
# Exits non-zero if any expected-reachable target is unreachable.
set -uo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/docker.sh
source "${LAB_DIR}/lib/docker.sh"
resolve_docker || exit 2

fail=0

check() { # check <description> <command...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[32mPASS\033[0m  %s\n' "${desc}"
  else
    printf '  \033[31mFAIL\033[0m  %s\n' "${desc}"
    fail=1
  fi
}

echo "== End-to-end host connectivity =="
check "PC1 -> PC2 (10.0.3.2)"  ${DOCKER} exec clab-acn-pc1 ping -c2 -W2 10.0.3.2
check "PC2 -> PC1 (10.0.1.2)"  ${DOCKER} exec clab-acn-pc2 ping -c2 -W2 10.0.1.2

echo "== Hop-by-hop router links =="
check "R1 -> R2 (10.0.12.2)"   ${DOCKER} exec clab-acn-r1 ping -c2 -W2 10.0.12.2
check "R2 -> R3 (10.0.23.2)"   ${DOCKER} exec clab-acn-r2 ping -c2 -W2 10.0.23.2

echo "== Router loopbacks from the host (data-plane path) =="
check "host -> R1 lo (10.255.0.1)"  ping -c2 -W2 10.255.0.1
check "host -> R2 lo (10.255.0.2)"  ping -c2 -W2 10.255.0.2
check "host -> R3 lo (10.255.0.3)"  ping -c2 -W2 10.255.0.3

echo
if [ "${fail}" -eq 0 ]; then
  echo "All connectivity checks passed."
else
  echo "Some checks FAILED - the lab is not in a healthy baseline state." >&2
fi
exit "${fail}"
