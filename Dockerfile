# ─────────────────────────────────────────────────────────────────────────────
# Production Multi-Stage Dockerfile for gdsl-exchange-api
# Monorepo: Express API + Socket.IO + Prisma DB package + Bot + Executor
# ─────────────────────────────────────────────────────────────────────────────

# Stage 1: Build & Compile
FROM node:22-slim AS builder

WORKDIR /app

# Install build toolchain for C++ native bindings (onnxruntime-node, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests across monorepo
COPY package*.json ./
COPY packages/db/package*.json ./packages/db/
COPY packages/binance-executor/package*.json ./packages/binance-executor/
COPY packages/dex-pancake/package*.json ./packages/dex-pancake/
COPY packages/bot/package*.json ./packages/bot/

# Install dependencies (ci for deterministic builds)
RUN npm ci

# Copy entire repository source code
COPY . .

# Generate Prisma Client & compile TypeScript workspace packages
RUN npm run db:generate
RUN npm run build:packages
RUN npm run build

# Remove development dependencies to keep production footprint minimal
RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Production Runtime
FROM node:22-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8000

# Run container process under non-root node user (UID 1000)
USER node

# Copy built application artifacts and dependencies from builder stage
COPY --chown=node:node --from=builder /app/package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/packages ./packages
COPY --chown=node:node --from=builder /app/src ./src

# Expose API service port
EXPOSE 8000

# Health check targeting Express /health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

# Start production API server
CMD ["node", "dist/index.js"]
