# gdsl-exchange-api

Standalone backend for **Godslandx / koie.fin** — Express REST API, Socket.IO, Prisma/Postgres, trading bots, Jupiter/Binance integrations.

The frontend lives in a separate repo: [Madhusahitya/gdsl-exchange-web](https://github.com/Madhusahitya/gdsl-exchange-web).

Production: [trade.godslandx.com](https://trade.godslandx.com)

## Quick start

```bash
git clone git@github.com:Madhusahitya/gdsl-exchange-api.git
cd gdsl-exchange-api
cp .env.example .env          # edit DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
npm install
npm run db:migrate
npm run dev                     # http://localhost:8000/health (local dev)
```

Or with Docker (production-like, port **4000**):

```bash
cp .env.example .env
# set PORT=4000 in .env for docker compose
docker compose up --build      # http://localhost:4000/health
```

## Repo layout

| Path | Purpose |
|------|---------|
| `src/index.ts` | Boot — HTTP server + Socket.IO |
| `src/server/` | Express app, routes mount, **socketServer.ts**, background jobs |
| `src/routes/` | HTTP handlers (one file per domain) |
| `src/services/` | Business logic |
| `packages/db/` | Prisma schema + migrations |
| `packages/bot/` | Paper/live bot engine |
| `packages/binance-executor/` | Binance REST executor |
| `packages/dex-pancake/` | BSC/PancakeSwap ABIs |

**WebSockets:** extend `src/server/socketServer.ts` — Socket.IO is already wired.

Full handoff notes: [`docs/BACKEND_ENGINEER_HANDOFF.md`](docs/BACKEND_ENGINEER_HANDOFF.md)

## Deploy

Push to `main` → GitHub Actions builds `ghcr.io/madhusahitya/gdsl-exchange-api:latest`.

The production droplet pulls that image via the [gdsl-exchange](https://github.com/Madhusahitya/gdsl-exchange) deploy repo's `docker-compose.yml`.
