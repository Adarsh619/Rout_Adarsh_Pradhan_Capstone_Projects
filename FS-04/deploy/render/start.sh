#!/bin/sh
# Entry point of the all-in-one live container: derive host settings, migrate, then start every process.
set -e
: "${DATABASE_URL:?Set DATABASE_URL (the Neon connection string) in the service environment}"
: "${DJANGO_SECRET_KEY:?Set DJANGO_SECRET_KEY in the service environment}"

# Render provides RENDER_EXTERNAL_HOSTNAME and RENDER_GIT_COMMIT; anything set explicitly wins.
host="${RENDER_EXTERNAL_HOSTNAME:-localhost}"
export DJANGO_ALLOWED_HOSTS="${DJANGO_ALLOWED_HOSTS:-$host,localhost,127.0.0.1}"
export CSRF_TRUSTED_ORIGINS="${CSRF_TRUSTED_ORIGINS:-https://$host}"
export FRONTEND_URL="${FRONTEND_URL:-https://$host}"
export APP_VERSION="${APP_VERSION:-${RENDER_GIT_COMMIT:-}}"

envsubst '${PORT}' < /etc/nginx/taskflow.conf.template > /tmp/nginx.conf

cd /app
python manage.py migrate --noinput
exec supervisord -c /etc/supervisor/taskflow.conf
