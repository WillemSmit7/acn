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

  # Docker exists but is unreachable. By far the most common cause is that the
  # shell predates the 'usermod -aG docker' from install-prereqs.sh.
  cat >&2 <<'MSG'
ERROR: cannot talk to the Docker daemon.

If you are in the docker group but your shell predates it (check with `id`),
activate the membership without logging out:

    newgrp docker

Then re-run this script. A permanent fix is to log out and back in.

Otherwise, verify the daemon is running:

    systemctl status docker
MSG
  return 1
}
