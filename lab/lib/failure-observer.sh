#!/usr/bin/env bash
# Shared precondition helper for ISP failure scenarios. Observation is owned by
# Layer Zero's autonomous state observer; scenario scripts only inject faults.

require_router() {
  local node="$1"
  if [ "$(${DOCKER} inspect -f '{{.State.Running}}' "clab-acn-${node}" 2>/dev/null || true)" != "true" ]; then
    echo "ERROR: clab-acn-${node} is not running; deploy or restore the lab first" >&2
    return 1
  fi
}
