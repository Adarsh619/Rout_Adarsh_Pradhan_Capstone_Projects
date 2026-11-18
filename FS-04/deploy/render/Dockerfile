# The whole TaskFlow stack in ONE container, for a single free web service (Render's free plan has no
# background workers). Postgres stays outside (Neon). Build context: the FS-04 folder.
#   docker build -f deploy/render/Dockerfile -t taskflow-live .
# supervisord runs: nginx (React build + /api proxy) · the Node.js API with the BullMQ worker inside it ·
# Redis (in-memory) · stripe-mock. Sized for 512 MB RAM / 0.1 CPU. Local development keeps docker-compose.yml.

FROM node:24-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_DEMO_HINT=true
ENV VITE_DEMO_HINT=$VITE_DEMO_HINT
RUN npm run build

FROM node:24-slim AS api
WORKDIR /api
COPY backend/package.json backend/package-lock.json backend/prisma.config.ts ./
COPY backend/prisma ./prisma
RUN npm ci
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
RUN npx prisma generate && npm run build && npm prune --omit=dev

# Same pinned version as docker-compose.yml and CI; only its static binary is copied.
FROM stripe/stripe-mock:v0.206.0 AS stripemock

FROM node:24-slim
# openssl: Prisma's migration engine links against it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx redis-server supervisor gettext-base openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default
# Prefer IPv4: the platform has no IPv6 route, and database hosts (Neon) also publish IPv6 addresses.
RUN echo "precedence ::ffff:0:0/96  100" >> /etc/gai.conf
WORKDIR /app
COPY --from=api /api/package.json /api/prisma.config.ts ./
COPY --from=api /api/node_modules ./node_modules
COPY --from=api /api/prisma ./prisma
COPY --from=api /api/dist ./dist
COPY backend/openapi.yaml ./openapi.yaml
RUN useradd --create-home app && mkdir -p /app/media && chown -R app /app/media
COPY --from=web /web/dist /usr/share/taskflow-web
COPY --from=stripemock /bin/stripe-mock /usr/local/bin/stripe-mock
COPY deploy/render/nginx.conf.template /etc/nginx/taskflow.conf.template
COPY deploy/render/supervisord.conf /etc/supervisor/taskflow.conf
COPY deploy/render/start.sh /usr/local/bin/taskflow-start
RUN sed -i 's/\r$//' /usr/local/bin/taskflow-start /etc/supervisor/taskflow.conf /etc/nginx/taskflow.conf.template \
    && chmod +x /usr/local/bin/taskflow-start

# Live-site defaults; secrets (DATABASE_URL, SECRET_KEY) come from the host's environment settings.
# TRUSTED_PROXY_COUNT=4, measured on Render: Cloudflare edge -> Render load balancer -> Render proxy -> our nginx.
ENV NODE_ENV=production \
    PORT=10000 \
    API_PORT=8000 \
    DEBUG=false \
    DEMO_MODE=true \
    EMBEDDED_WORKER=true \
    STRIPE_MOCK=true \
    STRIPE_API_BASE=http://127.0.0.1:12111 \
    REDIS_URL=redis://127.0.0.1:6379/0 \
    TRUSTED_PROXY_COUNT=4 \
    MEDIA_ROOT=/app/media \
    NODE_OPTIONS=--max-old-space-size=192
EXPOSE 10000
CMD ["taskflow-start"]
