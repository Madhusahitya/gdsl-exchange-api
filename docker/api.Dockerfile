# gdsl-exchange-api — production image (standalone repo)
FROM node:20-bookworm-slim AS builder
RUN apt-get update && apt-get install -y openssl ca-certificates python3 make g++ \
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

FROM node:20-bookworm-slim AS runner
RUN apt-get update && apt-get install -y openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages
COPY docker/api-entry.sh /app/api-entry.sh
RUN chmod +x /app/api-entry.sh
EXPOSE 4000
CMD ["/app/api-entry.sh"]
