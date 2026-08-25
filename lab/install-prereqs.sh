#!/usr/bin/env bash
# Install Docker Engine and Containerlab on Ubuntu.
# Requires sudo. Run once, then log out and back in (for the docker group).
set -euo pipefail

echo "==> Installing Docker Engine"
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  # Ubuntu 26.04 (resolute) has no Docker repo yet - fall back to the 24.04 suite.
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  case "${CODENAME}" in
    resolute|questing|plucky|oracular) CODENAME="noble" ;;
  esac
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  sudo usermod -aG docker "${USER}"
  echo "    NOTE: docker group membership does not apply to your current shell."
else
  echo "    Docker already installed: $(docker --version)"
fi

echo "==> Installing Containerlab"
if ! command -v containerlab >/dev/null 2>&1; then
  bash -c "$(curl -sL https://get.containerlab.dev)"
else
  echo "    Containerlab already installed: $(containerlab version | head -1)"
fi

echo "==> Pre-pulling lab images"
sudo docker pull quay.io/frrouting/frr:10.2.1
sudo docker pull ghcr.io/hellt/network-multitool:latest

echo
echo "==> Prerequisites installed."
if ! docker info >/dev/null 2>&1; then
  cat <<'MSG'

    IMPORTANT: your current shell cannot reach Docker yet, because its
    docker-group membership was granted after the shell started. Activate it:

        newgrp docker

    (or log out and back in for a permanent fix), then continue.
MSG
fi
echo "==> Next: ./lab/deploy.sh"
