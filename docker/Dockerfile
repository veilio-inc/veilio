# Node 24 matches what CI builds with; the root package requires >=22.19.0, so
# the previous node:20 base was below the declared floor.
FROM node:24-alpine AS build
WORKDIR /app

# The root package pulls the anonymization engine in through
# `file:./packages/engine`, and the postinstall script builds it from source.
# Both need the engine present before `npm ci` runs — copying only the two root
# manifests made the install fail with ENOENT on packages/engine/package.json,
# so this image could not be built at all. The engine is copied as its own
# layer, ahead of the app sources, so editing a component still reuses the
# cached dependency install.
COPY package.json package-lock.json ./
COPY packages/engine packages/engine
RUN npm ci

# Relies on .dockerignore keeping node_modules and dist out of the context: a
# host node_modules copied over the installed one would replace Linux binaries
# with the build machine's (macOS esbuild, fsevents) and break the Vite build.
COPY . .

# Vite inlines env vars at build time, so the Cloud CTA target is baked into the
# bundle here — it cannot be changed later with `docker run -e`. The release
# workflow passes this with --build-arg; without the ARG line Docker accepts the
# flag and silently discards it, so the value never reached the build. The
# default matches the fallback in src/pages/PricingPage.tsx.
ARG VITE_VEILIO_CLOUD_URL=https://veilio.dev
ENV VITE_VEILIO_CLOUD_URL=$VITE_VEILIO_CLOUD_URL
RUN npm run build

# alpine-slim rather than alpine: 20.6 MB against 76.8 MB, which is the whole
# difference between a 77.4 MB image and a 21.7 MB one — the site itself is only
# 1.1 MB, so the base was almost all of it. slim drops the njs, geoip and perl
# modules. gzip is nginx core, so compression, the SPA fallback and both
# cache-control rules in nginx.conf are unaffected; all four were re-checked
# against a running container before this change landed.
FROM nginx:1.27-alpine-slim
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
