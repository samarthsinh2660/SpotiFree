# syntax=docker/dockerfile:1

# Node 24 is pinned here, so the host does not need Node installed at all —
# and node:sqlite (requires >= 22.5) is guaranteed available.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DB_PATH=/app/data/cache.db

RUN addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static

# Track cache + saved playlists live here; mounted as a volume so they survive
# container rebuilds.
RUN mkdir -p /app/data && chown app:app /app/data
VOLUME ["/app/data"]

USER app
EXPOSE 3000
CMD ["node", "server.js"]
