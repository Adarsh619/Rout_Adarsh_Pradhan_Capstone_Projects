# Build the React app, then serve it with nginx (which also proxies /api to Django).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
# Set to "false" to hide the demo login hint on the sign-in page (e.g. for a public deployment).
ARG VITE_DEMO_HINT="true"
ENV VITE_DEMO_HINT=$VITE_DEMO_HINT
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
