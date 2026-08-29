# Node 24 matches what CI builds with; the root package requires >=22.19.0, so
# the previous node:20 base was below the declared floor.
# Base images are pinned by digest, not by tag (ROADMAP E4). A tag is a mutable
# pointer: `node:24-alpine` today and `node:24-alpine` next week are different
# bytes, so an unpinned build is a build nobody can reproduce or audit.
#
# Both digests below are multi-arch OCI *indexes*, which matters — the release
# workflow builds linux/amd64 and linux/arm64, and pinning a single-platform
# manifest by mistake breaks the arm64 leg at build time. Dependabot moves these
# forward; see .github/dependabot.yml.
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS build
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

# @playwright/test is a devDependency (the e2e suite), and devDependencies are
# required here because Vite and TypeScript are among them. Its install step
# would otherwise pull ~100 MB of browsers into a build that never runs a test.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
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

# Compress once here rather than per request at runtime. -k keeps the original
# alongside, for clients that don't send Accept-Encoding: gzip. Images and fonts
# are already compressed, so gzipping them would add bytes to the image and save
# none on the wire.
RUN find dist -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.json' -o -name '*.map' \) \
      -exec gzip -9 -k {} +

# The server is ~140 lines of standard library (docker/serve.go). Trading nginx
# for it is what lets the final stage be `scratch`: with alpine-slim the distro
# was 20.6 MB of a 21.7 MB image, so the site was under 5% of what users pulled.
FROM golang:1.27-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS server
WORKDIR /src
COPY docker/serve.go .
# CGO off gives a genuinely static binary — mandatory, since scratch has no libc
# to dynamically link against. -trimpath keeps build paths out of it, and -s -w
# drop the symbol table and DWARF data that only a debugger would want.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /veilio-serve serve.go

# No distro at all: one binary and the site. Nothing to patch, no shell to get a
# foothold in, and no package manager in the image.
FROM scratch
COPY --from=server /veilio-serve /veilio-serve
COPY --from=build /app/dist /site

# Unprivileged. Docker sets net.ipv4.ip_unprivileged_port_start=0 in containers,
# so uid 65534 can still bind 80 and the documented `-p 8080:80` keeps working.
# On a runtime that does not (some Kubernetes setups), pass `-addr :8080`.
USER 65534:65534
EXPOSE 80

# There is no shell, so the check has to re-enter the binary. Exec form only.
HEALTHCHECK --interval=30s --timeout=5s --start-period=2s \
  CMD ["/veilio-serve", "-healthcheck"]

ENTRYPOINT ["/veilio-serve"]
