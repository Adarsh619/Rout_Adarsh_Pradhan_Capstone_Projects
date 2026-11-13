#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 24.04 (arm64) EC2 server for ShopSphere. Safe to run again.
#   sudo bash deploy/server-setup.sh
# Installs Docker from Ubuntu's own packages, adds 2 GB of swap (the t4g.small has 2 GB of memory),
# and sets the kernel setting Elasticsearch needs.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/server-setup.sh" >&2
  exit 1
fi

echo "==> Updating packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y docker.io docker-compose-v2 git curl unattended-upgrades

echo "==> Docker"
systemctl enable --now docker
# Let the login user run docker without sudo (takes effect after logging in again).
TARGET_USER="${SUDO_USER:-ubuntu}"
usermod -aG docker "$TARGET_USER"

echo "==> Swap (2 GB)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# Use swap only when memory is really short.
sysctl -w vm.swappiness=10 >/dev/null

echo "==> Elasticsearch kernel setting"
sysctl -w vm.max_map_count=262144 >/dev/null
cat > /etc/sysctl.d/99-shopsphere.conf <<'EOF'
vm.max_map_count=262144
vm.swappiness=10
EOF

echo "==> Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo
echo "Done. Log out and back in (so 'docker' works without sudo), then from FS-01/:"
echo "  cp deploy/production.env.example .env && nano .env"
echo "  docker compose -f docker-compose.prod.yml up -d --build"
docker --version
docker compose version
free -h
