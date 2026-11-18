#!/bin/sh
# Entry point of the all-in-one live container: derive host settings, migrate, then start every process.
set -e
: "${DATABASE_URL:?Set DATABASE_URL (the Neon connection string) in the service environment}"
# SECRET_KEY signs login tokens; the v1 (Django) name DJANGO_SECRET_KEY is still accepted.
if [ -z "${SECRET_KEY:-}" ] && [ -z "${DJANGO_SECRET_KEY:-}" ]; then
  echo "Set SECRET_KEY in the service environment" >&2
  exit 1
fi

# Render provides RENDER_EXTERNAL_HOSTNAME and RENDER_GIT_COMMIT; anything set explicitly wins.
host="${RENDER_EXTERNAL_HOSTNAME:-localhost}"
export FRONTEND_URL="${FRONTEND_URL:-https://$host}"
export CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-https://$host}"
export APP_VERSION="${APP_VERSION:-${RENDER_GIT_COMMIT:-}}"

envsubst '${PORT}' < /etc/nginx/taskflow.conf.template > /tmp/nginx.conf

cd /app
node_modules/.bin/prisma migrate deploy
exec supervisord -c /etc/supervisor/taskflow.conf
