# The whole TaskFlow stack in ONE container, for a single free web service (Render's free plan has no
# background workers). Postgres stays outside (Neon). Build context: the FS-04 folder.
#   docker build -f deploy/render/Dockerfile -t taskflow-live .
# supervisord runs: nginx (React build + /api proxy) · gunicorn · Celery worker with embedded beat ·
# Redis (in-memory) · stripe-mock. Sized for 512 MB RAM / 0.1 CPU. Local development keeps docker-compose.yml.

FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_DEMO_HINT=true
ENV VITE_DEMO_HINT=$VITE_DEMO_HINT
RUN npm run build

# Same pinned version as docker-compose.yml and CI; only its static binary is copied.
FROM stripe/stripe-mock:v0.206.0 AS stripemock

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx redis-server supervisor gettext-base \
    && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default
# Prefer IPv4: the platform has no IPv6 route, and database hosts (Neon) also publish IPv6 addresses.
RUN echo "precedence ::ffff:0:0/96  100" >> /etc/gai.conf
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/ ./
RUN DJANGO_SECRET_KEY=build python manage.py collectstatic --noinput \
    && useradd --create-home app && mkdir -p /app/media && chown -R app /app
COPY --from=web /web/dist /usr/share/taskflow-web
COPY --from=stripemock /bin/stripe-mock /usr/local/bin/stripe-mock
COPY deploy/render/nginx.conf.template /etc/nginx/taskflow.conf.template
COPY deploy/render/supervisord.conf /etc/supervisor/taskflow.conf
COPY deploy/render/start.sh /usr/local/bin/taskflow-start
RUN sed -i 's/\r$//' /usr/local/bin/taskflow-start /etc/supervisor/taskflow.conf /etc/nginx/taskflow.conf.template \
    && chmod +x /usr/local/bin/taskflow-start

# Live-site defaults; secrets (DATABASE_URL, DJANGO_SECRET_KEY) come from the host's environment settings.
ENV PORT=10000 \
    DJANGO_DEBUG=false \
    DEMO_MODE=true \
    SECURE_PROXY_SSL=true \
    STRIPE_MOCK=true \
    STRIPE_API_BASE=http://127.0.0.1:12111 \
    REDIS_URL=redis://127.0.0.1:6379/0 \
    TRUSTED_PROXY_COUNT=2 \
    MEDIA_ROOT=/app/media
EXPOSE 10000
CMD ["taskflow-start"]
