# Backend Engineer Handoff Guide

Welcome to the **Godslandx / koie.fin Trading API** backend repository (`gdsl-exchange-api`).  
This repository contains the standalone, high-concurrency trading backend built with Node.js / TypeScript, Express, Socket.IO, Prisma ORM, Redis, and multi-chain DEX/CEX executors.

> [!NOTE]  
> Do not clone `gdsl-exchange` for backend work — that repository is for frontend web applications only.

---

## 1. System Architecture Overview

The backend is built with a **4-Service Decoupled Architecture** powered by Redis for horizontal scaling, distributed event streaming, and RAM caching:

```
                          ┌────────────────────────┐
                          │   Client Browser / UI  │
                          └───────────┬────────────┘
                                      │
              ┌───────────────────────┴───────────────────────┐
              │           Nginx Reverse Proxy / Ingress       │
              └───────────────┬───────────────────────┬───────┘
                     (HTTP)   │                       │ (WebSockets)
                              ▼                       ▼
                     ┌────────────────┐      ┌────────────────┐
                     │ Service 1: API │      │ Service 2: WSS │
                     │  (port 8000)   │      │  (port 8001)   │
                     └────────┬───────┘      └────────┬───────┘
                              │                       │
                              │     ┌───────────┐     │
                              ├────►│   Redis   │◄────┤
                              │     │  Pub/Sub  │     │
                              │     │  & Cache  │     │
                              │     └─────▲─────┘     │
                              ▼           │           ▼
                     ┌────────────────┐   │  ┌────────────────┐
                     │ Service 3: Bot │───┤  │ Service 4: Job │
                     │ Trading Engine │   │  │ Async Workers  │
                     └────────┬───────┘   │  └────────┬───────┘
                              │           │           │
                              └───────────┼───────────┘
                                          ▼
                               ┌─────────────────────┐
                               │ PostgreSQL Database │
                               └─────────────────────┘
```

### The 4 Decoupled Services:

| Service | Entry File | Docker Service | Description |
| :--- | :--- | :--- | :--- |
| **1. REST API** | [`src/server.ts`](file:///d:/faiz-p/gdsl-exchange-api/src/server.ts) | `api` (Port 8000) | Stateless Express API for user auth, KYC, portfolio queries, manual order placement, and settings. Also mounts Socket.IO for unified single-port local dev. |
| **2. Socket Gateway** | [`src/socket.ts`](file:///d:/faiz-p/gdsl-exchange-api/src/socket.ts) | `socket` (Port 8001) | Dedicated WebSocket connection manager with `@socket.io/redis-adapter` for multi-node horizontal scaling. Delivers user notifications and market tickers. |
| **3. Trading Engine** | [`src/tradingEngine.ts`](file:///d:/faiz-p/gdsl-exchange-api/src/tradingEngine.ts) | `trading-engine` | On-chain position watchers (Jupiter, Pancake, 1inch TP/SL/Trailing Stop), AI Super Machine bots, and Binance paper trader. |
| **4. Async Worker** | [`src/worker.ts`](file:///d:/faiz-p/gdsl-exchange-api/src/worker.ts) | `worker` | Background maintenance: Binance order reconciliation, cross-chain credit retry sweeps, Kline OHLCV candle ingestion, ML Bayesian prior updates, and Telegram alerts. |

---

## 2. Getting Started Locally

### Prerequisites
- Node.js `v20.0.0` or higher (Node 22 recommended)
- PostgreSQL (running locally on port 5432 or via Docker)
- Redis (running locally on port 6379 or via Docker)

### Setup Steps

```bash
git clone git@github.com:Madhusahitya/gdsl-exchange-api.git
cd gdsl-exchange-api

# 1. Copy environment template
cp .env.example .env

# 2. Install workspace dependencies
npm install

# 3. Build monorepo packages (db, bot, executors)
npm run build:packages

# 4. Run database migrations
npm run db:migrate
```

### Environment Configuration (`.env`)

Minimum required configuration:

```ini
NODE_ENV=development
PORT=8000
SOCKET_PORT=8001
REDIS_URL=redis://127.0.0.1:6379
DATABASE_URL="postgresql://postgres:root@localhost:5432/cryptoflow?schema=public"

JWT_SECRET="your-secure-jwt-secret"
ENCRYPTION_KEY="your-32-byte-hex-encryption-key"
WALLET_ENCRYPTION_KEY="your-32-byte-hex-wallet-key"
```

> [!TIP]  
> To generate a random 32-byte hex key for `ENCRYPTION_KEY` and `WALLET_ENCRYPTION_KEY`:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## 3. Running the Services

### Option A: Monolithic Dev Mode (Quick Local Development)
Runs all 4 subsystems in a single hot-reloading process on port 8000:
```bash
npm run dev
```
- Health Check: `http://localhost:8000/health`
- WebSocket endpoint: `ws://localhost:8000`

### Option B: Decoupled Independent Processes
You can run each service independently in separate terminal windows:
```bash
# Terminal 1: REST API (Port 8000)
npm run dev:api

# Terminal 2: Socket Gateway (Port 8001)
npm run dev:socket

# Terminal 3: Trading Engine & Position Watchers
npm run dev:trading

# Terminal 4: Background Workers & Reconciliation
npm run dev:worker
```

### Option C: Full Stack Docker Compose
Runs all 4 services plus Redis and PostgreSQL:
```bash
# Build and start all containers in detached mode
docker compose up -d --build

# View running services
docker compose ps

# Follow logs for all services or a specific container
docker compose logs -f api
docker compose logs -f socket
docker compose logs -f trading-engine
docker compose logs -f worker

# Stop containers
docker compose down
```

### Option D: High-Concurrency Benchmark
To verify API throughput and Redis caching under load:
```bash
npm run benchmark
```

---

## 4. Interactive API Documentation (Swagger / OpenAPI 3.0)

The backend exposes an interactive **Swagger UI** and **OpenAPI 3.0** specification for testing endpoints, exploring schemas, and generating client libraries.

### Accessing Swagger UI
- **Local Dev UI:** [http://localhost:8000/docs](http://localhost:8000/docs) (also mirrored at `/api/docs`)
- **Raw OpenAPI JSON:** [http://localhost:8000/docs.json](http://localhost:8000/docs.json) (or `/api/docs.json`)
- **Production UI:** `https://api.godslandx.com/docs`

### Testing Authenticated Routes
1. Make a `POST /api/auth/login` request with your credentials (or test via the UI).
2. Copy the returned `token`.
3. Click the green **Authorize** button at the top right of the Swagger UI.
4. Enter `Bearer <your_token>` and click **Authorize**.
5. All authenticated requests (Dashboard, DEX Swaps, Bot status, Orders) will now automatically include the Bearer token in their headers.

### Postman / Client Generation
You can import `http://localhost:8000/docs.json` directly into **Postman** (`Import -> Link`) or tools like `openapi-typescript` to auto-generate fully typed TypeScript API clients.

---

## 5. Real-time Events & WebSockets

WebSockets are handled via [`src/server/socketServer.ts`](file:///d:/faiz-p/gdsl-exchange-api/src/server/socketServer.ts) and backed by [`src/lib/pubsub.ts`](file:///d:/faiz-p/gdsl-exchange-api/src/lib/pubsub.ts).  
All events are pushed reactively via Redis Pub/Sub; **there is no database polling loop bombing the database**.

### Socket Events Reference

| Event | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `trade:executed` | Server → Client | `{ tradeId, symbol, side, price, amount }` | Triggered when a trade executes successfully |
| `trade:failed` | Server → Client | `{ symbol, reason, timestamp }` | Triggered on trade execution failure |
| `portfolio:update` | Server → Client | `{ totalBalance, pnl, positions }` | Emitted when user balances change |
| `performance:update` | Server → Client | `{ winRate, totalTrades, dailyPnl }` | Updates trader statistics |
| `positions:refresh` | Server → Client | `{ openPositions }` | Triggers UI to refresh active open positions |
| `jupiter:position_closed`| Server → Client | `{ positionId, reason, pnl }` | Emitted when TP/SL is triggered on Solana |
| `cex-sm:trade` | Server → Client | `{ botId, action, symbol, price }` | Emitted by CEX Super Machine agents |
| `price:update` | Server → Client | `{ symbol, price, change24h }` | Market price tick streams |

### User Room Isolation
Upon connection, authenticated clients join room `user:{userId}`.  
Private events are emitted directly to the user's room:
```typescript
import { getSocketIo } from './lib/realtimeHub'

// Emit to a specific user across any cluster node
getSocketIo()?.to(`user:${userId}`).emit('trade:executed', tradeData)
```

---

## 6. Production Server & Deployment

### Production Droplet Details

- **Host IP:** `157.245.100.175`
- **SSH User:** `root` (your SSH key is already authorized)
- **App Directory:** `/opt/trade_bot`
- **Host Database:** Port `5433` on host `127.0.0.1` (or managed container)
- **Live Frontend:** [https://trade.godslandx.com](https://trade.godslandx.com)
- **Live API:** [https://api.godslandx.com](https://api.godslandx.com)
- **Live WebSocket:** `wss://api.godslandx.com`

### SSH Login & Deployment Workflow

```bash
# 1. SSH into the server
ssh root@157.245.100.175

# 2. Navigate to application folder
cd /opt/trade_bot

# 3. Pull latest code
git pull origin main

# 4. Rebuild and restart containers
docker compose up -d --build

# 5. Check container health
docker compose ps
curl -s http://127.0.0.1:8000/health
```

### Database Backups
To take an ad-hoc PostgreSQL backup:
```bash
pg_dump 'postgresql://postgres:PASSWORD@127.0.0.1:5433/cryptoflow' --no-owner --no-acl > cryptoflow_backup_$(date +%F).sql
```

---

## 7. Recommended Nginx Reverse Proxy Configuration

On the production droplet (`157.245.100.175`), Nginx routes HTTP REST traffic to Port 8000 and WebSocket connections to Port 8001:

```nginx
# /etc/nginx/sites-available/api.godslandx.com

server {
    server_name api.godslandx.com;

    # 1. REST API traffic -> Service 1 (Port 8000)
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 2. Real-time WebSockets -> Service 2 (Port 8001)
    location /socket.io/ {
        proxy_pass http://127.0.0.1:8001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    listen 443 ssl;
    # Managed by Certbot (Let's Encrypt)
}
```

---

## 8. Key Code Locations

```
gdsl-exchange-api/
├── src/
│   ├── index.ts                    # Combined dev entrypoint (starts all services)
│   ├── server.ts                   # Service 1: Stateless REST API
│   ├── socket.ts                   # Service 2: Realtime Socket Gateway
│   ├── tradingEngine.ts            # Service 3: Automated Trading Engine & Watchers
│   ├── worker.ts                   # Service 4: Async Background Workers & Feed Ingestion
│   │
│   ├── docs/
│   │   └── swaggerSpec.ts          # OpenAPI 3.0 specification & schema models
│   │
│   ├── lib/
│   │   ├── redis.ts                # Redis connection, pool, and cache helpers (cacheGet/Set)
│   │   ├── pubsub.ts               # AutoPubSub (Redis with EventEmitter fallback)
│   │   ├── realtimeHub.ts          # Centralized getSocketIo() emitter
│   │   └── logger.ts               # Pino structured JSON logger
│   │
│   ├── routes/                     # Express REST endpoint handlers
│   │   ├── dashboard.ts            # Dashboard summary (Redis-cached, 8s TTL)
│   │   ├── dexJupiter.ts           # Jupiter Solana DEX swap & limit orders (with fallback)
│   │   ├── dexPancake.ts           # PancakeSwap BSC routes
│   │   └── ...
│   │
│   ├── server/
│   │   ├── createApp.ts            # Express configuration, middleware, Swagger mount
│   │   ├── registerRoutes.ts       # All /api/* route mounts
│   │   └── socketServer.ts         # Socket.IO connection handling & Redis adapter
│   │
│   └── services/                   # Business logic layer
│       ├── agents/                 # Super Machine autonomous AI trading bots
│       ├── dex/                    # Jupiter & 1inch swap routing & registry
│       ├── market/                 # Klines, order book feeds
│       └── trading/                # Position watchers & stop-loss / take-profit executors
│
├── packages/
│   ├── db/                         # Prisma database schema & migrations
│   ├── bot/                        # Strategy definitions & paper trading engine
│   ├── binance-executor/           # Binance live execution
│   └── dex-pancake/                # PancakeSwap SDK & execution
│
├── docker/
│   └── api.Dockerfile              # Multi-stage production container build
├── docker-compose.yml              # 4-Service orchestration + Redis + Postgres
└── scripts/
    └── benchmark-test.ts           # High-load performance testing script
```

---

## 9. Safety & Guardrails

1. **Hot Wallet Safety:** Never log or expose raw private keys or seed phrases in logs or HTTP responses. Keep `ENCRYPTION_KEY` and `WALLET_ENCRYPTION_KEY` strictly secret.
2. **Never commit `.env`:** Ensure `.env` remains in `.gitignore`.
3. **Database Changes:** Always create Prisma migrations (`npm run db:migrate`) rather than applying manual SQL alterations on production databases.
4. **Graceful Fallbacks:** External RPCs (Solana, BSC, Binance) will occasionally rate-limit or fail. Wrap external network calls with timeout handlers and cached fallbacks (see [`src/routes/dexJupiter.ts`](file:///d:/faiz-p/gdsl-exchange-api/src/routes/dexJupiter.ts) for reference).
