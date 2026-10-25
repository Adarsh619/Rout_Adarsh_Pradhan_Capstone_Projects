#!/bin/sh
set -e
# Run migrations only from the web container (RUN_MIGRATIONS=1), not from every worker.
if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
  python manage.py migrate --noinput
fi
exec "$@"
