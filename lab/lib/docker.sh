# Resolve how to invoke Docker on this host, once, for every lab script.
#
# Sets DOCKER to either "docker" or "sudo docker". Fails loudly if neither
# works: a Docker permission problem must never be reported as a network
# failure, and a restore script must never claim success without running.
#
# Usage:
#   source "${LAB_DIR}/lib/docker.sh"
#   resolve_docker
#   ${DOCKER} exec clab-acn-r2 ...

# True when the user is a docker-group member on the system but the CURRENT
# process does not carry that group. This is the single most common cause of a
# permission denied on the socket, and it is invisible in `groups` output alone.
_docker_group_is_stale() {
  local system_groups process_groups
  system_groups="$(id -nG "${USER}" 2>/dev/null || echo '')"
  process_groups="$(id -nG 2>/dev/null || echo '')"

  [[ " ${system_groups} " == *" docker "* ]] && [[ " ${process_groups} " != *" docker "* ]]
}

resolve_docker() {
  if docker info >/dev/null 2>&1; then
    DOCKER="docker"
    return 0
  fi

  if sudo -n docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is not installed. Run ./lab/install-prereqs.sh first." >&2
    return 1
  fi

  if _docker_group_is_stale; then
    cat >&2 <<'MSG'
ERROR: cannot talk to the Docker daemon - stale group membership.

You ARE in the docker group on this system, but this process started before
that membership existed, so it does not carry the group. Compare:

    id -nG $USER     # includes 'docker'
    id -nG           # does not

Fix it by starting a NEW login session. Any of these work:

    - Close and reopen your terminal (a fresh login shell)
    - Restart VS Code / the Claude Code session, if running inside one
    - Log out and back in (always works)

`newgrp docker` / `sg docker` would also work, but neither is installed here.
MSG
    return 1
  fi

  cat >&2 <<'MSG'
ERROR: cannot talk to the Docker daemon.

Check that the daemon is running and that you are in the docker group:

    systemctl status docker
    id -nG $USER

If 'docker' is missing from your groups, run:

    sudo usermod -aG docker "$USER"

then start a new login session.
MSG
  return 1
}
