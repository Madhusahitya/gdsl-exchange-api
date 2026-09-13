# Alias Dockerfile for Docker Compose
FROM node:20-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY packages/db/package*.json ./packages/db/
COPY packages/binance-executor/package*.json ./packages/binance-executor/
COPY packages/dex-pancake/package*.json ./packages/dex-pancake/
COPY packages/bot/package*.json ./packages/bot/

RUN npm ci

COPY . .

RUN npm run db:generate
RUN npm run build:packages
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8000

USER node

COPY --chown=node:node --from=builder /app/package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/packages ./packages
COPY --chown=node:node --from=builder /app/src ./src

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

CMD ["node", "dist/index.js"]
