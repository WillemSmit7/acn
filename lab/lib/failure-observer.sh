#!/usr/bin/env bash
# Shared readback/evidence helpers for ISP failure scenarios.

emit_monitor_event() {
  local node="$1"
  local event_type="$2"
  shift 2
  local attributes=""
  local pair
  for pair in "$@"; do
    if [[ ! "${pair}" =~ ^[A-Za-z][A-Za-z0-9]*=[A-Za-z0-9_.:/-]+$ ]]; then
      echo "ERROR: unsafe monitor attribute: ${pair}" >&2
      return 2
    fi
    attributes+=" ${pair}"
  done

  ${DOCKER} exec "clab-acn-${node}" sh -c '
    stamp=$(date -u +"%Y/%m/%d %H:%M:%S")
    printf "%s ACNMON: [ACNMO-00001] EVENT type=%s%s\n" "$stamp" "$1" "$2" >> /var/log/frr/acn-monitor.log
  ' sh "${event_type}" "${attributes}"
}

require_router() {
  local node="$1"
  if [ "$(${DOCKER} inspect -f '{{.State.Running}}' "clab-acn-${node}" 2>/dev/null || true)" != "true" ]; then
    echo "ERROR: clab-acn-${node} is not running; deploy or restore the lab first" >&2
    return 1
  fi
}
