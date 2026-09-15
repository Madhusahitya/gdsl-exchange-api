# gdsl-exchange-api — production image (standalone repo)
FROM node:20-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/binance-executor/package.json ./packages/binance-executor/
COPY packages/bot/package.json ./packages/bot/
COPY packages/db/package.json ./packages/db/
COPY packages/dex-pancake/package.json ./packages/dex-pancake/
RUN npm ci
COPY apps ./apps
COPY packages ./packages
WORKDIR /app/packages/db
RUN npx prisma generate
WORKDIR /app
RUN npm run build --workspace=@cryptoflow/db
RUN npm run build --workspace=@cryptoflow/dex-pancake
RUN npm run build --workspace=@cryptoflow/bot
RUN npm run build --workspace=@cryptoflow/binance-executor
RUN npm run build --workspace=apps/api
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages
COPY docker/api-entry.sh /app/api-entry.sh
RUN chmod +x /app/api-entry.sh && chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1
CMD ["/app/api-entry.sh"]
