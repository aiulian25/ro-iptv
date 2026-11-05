# syntax=docker/dockerfile:1

# ----------------------------------------------------------------------------
# Stage 1 — build the React/Vite frontend
# ----------------------------------------------------------------------------
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
# Code both halves run (the M3U parser, country detection, guide matching).
# Copied before the client sources so a shared change does not bust the npm layer.
COPY shared/ /app/shared/
COPY client/ ./
RUN npm run build

# ----------------------------------------------------------------------------
# Stage 2 — install backend production deps
# ----------------------------------------------------------------------------
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS server-deps
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev

# ----------------------------------------------------------------------------
# Stage 3 — final runtime image (single container: Express serves API + SPA)
# ----------------------------------------------------------------------------
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
ENV NODE_ENV=production \
    PORT=56892 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/server/public
WORKDIR /app/server

# Patch OS packages first, then install ffmpeg (required to capture recordings).
# `apk upgrade` pulls the latest Alpine security fixes at build time, so every
# rebuild incorporates patches; `--no-cache` leaves no package index behind.
RUN apk upgrade --no-cache && apk add --no-cache ffmpeg

# Drop the bundled npm/npx CLI: it's unused at runtime (the app runs `node`
# only) and is the source of most image CVEs (npm bundles tar/glob/minimatch/
# cross-spawn). Removing it shrinks the image and clears those findings — see §2
# "remove unused tools to shrink the image".
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Backend source, the shared modules it imports as ../../shared, and node_modules
COPY server/ ./
COPY shared/ /app/shared/
COPY --from=server-deps /app/server/node_modules ./node_modules
# Built frontend served as static files
COPY --from=client-build /app/client/dist ./public

RUN mkdir -p /data && \
    addgroup -g 1001 app && adduser -D -u 1001 -G app app && \
    chown -R app:app /app /data
# Numeric, so the uid resolves without this image's passwd file — a name needs
# a lookup the host or a user-namespaced runtime may not be able to perform.
USER 1001:1001

# OCI image labels — `source` lets GitHub link this package to its repository
# automatically. Placed late so it doesn't bust the build cache above.
LABEL org.opencontainers.image.title="RO-IPTV" \
      org.opencontainers.image.description="Self-hosted M3U/IPTV player PWA — Live TV, Radio, EPG and Recordings in a single image." \
      org.opencontainers.image.source="https://github.com/aiulian25/ro-iptv" \
      org.opencontainers.image.url="https://github.com/aiulian25/ro-iptv" \
      org.opencontainers.image.licenses="MIT"

VOLUME ["/data"]
EXPOSE 56892

# Exec form, so no shell is spawned every 30s. busybox wget already exits 1 on a
# non-200 or a refused connection, which is exactly what `|| exit 1` was doing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["wget", "-qO-", "http://127.0.0.1:56892/api/health"]

CMD ["node", "index.js"]
