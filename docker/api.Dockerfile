# gdsl-exchange-api — production & local Docker image
FROM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Copy all source files (excluding node_modules via .dockerignore)
COPY . .

# Use npm install for robust cross-platform workspace linking
RUN npm install

# Generate Prisma client and share across root and packages/db workspaces
RUN npx prisma generate --schema=packages/db/prisma/schema.prisma
RUN mkdir -p packages/db/node_modules && cp -r node_modules/.prisma packages/db/node_modules/ && cp -r node_modules/@prisma packages/db/node_modules/

# Compile workspace packages and TypeScript API servers
RUN npm run build:packages
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runner
RUN apt-get update && apt-get install -y openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/dist ./dist

EXPOSE 8000 8001
CMD ["node", "dist/index.js"]
