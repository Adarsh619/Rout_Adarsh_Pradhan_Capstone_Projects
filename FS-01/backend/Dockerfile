# One image for both the API (default) and the worker (`node dist/worker.js`).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# npm ci runs `prisma generate` (postinstall), which writes the typed client into src/generated.
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Prisma's migration engine links against OpenSSL.
RUN apk add --no-cache openssl
COPY package.json package-lock.json prisma.config.ts ./
# Migrations, applied by the API on start (`prisma migrate deploy`). Installing with scripts on also downloads the
# migration engine now, as root, rather than at start-up as the unprivileged user.
COPY prisma ./prisma
RUN npm ci --omit=dev && rm -rf src/generated && npm cache clean --force
COPY --from=build /app/dist ./dist
# The demo catalogue snapshot used by dist/scripts/seed-catalog.js.
COPY seed ./seed
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 4000
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/index.js"]
