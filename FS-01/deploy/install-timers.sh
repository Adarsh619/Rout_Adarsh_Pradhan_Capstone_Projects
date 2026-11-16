#!/usr/bin/env bash
# Installs the two systemd timers on the server. Safe to run again.
#   sudo bash deploy/install-timers.sh
#   shopsphere-deploy.timer  every 5 min: deploy the newest commit that passed CI (deploy/auto-deploy.sh)
#   shopsphere-reset.timer   03:00 IST daily: restore the demo baseline (deploy/demo-reset.sh)
# Logs: journalctl -u shopsphere-deploy -n 50     journalctl -u shopsphere-reset -n 50
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/install-timers.sh" >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_AS="${SUDO_USER:-ubuntu}"
RUN_HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)"

cat > /etc/systemd/system/shopsphere-deploy.service <<EOF
[Unit]
Description=ShopSphere auto-deploy (newest commit that passed CI)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_AS
Environment=HOME=$RUN_HOME
WorkingDirectory=$APP_DIR
ExecStart=/bin/bash $APP_DIR/deploy/auto-deploy.sh
TimeoutStartSec=45min
EOF

cat > /etc/systemd/system/shopsphere-deploy.timer <<'EOF'
[Unit]
Description=Check for a new passing ShopSphere commit every 5 minutes

[Timer]
OnBootSec=3min
OnUnitInactiveSec=5min

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/shopsphere-reset.service <<EOF
[Unit]
Description=ShopSphere nightly demo reset
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_AS
Environment=HOME=$RUN_HOME
WorkingDirectory=$APP_DIR
ExecStart=/bin/bash $APP_DIR/deploy/demo-reset.sh
TimeoutStartSec=30min
EOF

cat > /etc/systemd/system/shopsphere-reset.timer <<'EOF'
[Unit]
Description=Reset the ShopSphere demo every night at 03:00 IST

[Timer]
OnCalendar=*-*-* 03:00:00 Asia/Kolkata

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now shopsphere-deploy.timer shopsphere-reset.timer
systemctl list-timers 'shopsphere-*' --no-pager
