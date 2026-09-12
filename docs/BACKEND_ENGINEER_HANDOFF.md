# Backend engineer handoff

This is the **standalone API repo**. Clone only this — not `gdsl-exchange` (that repo is frontend/web only).

```bash
git clone git@github.com:Madhusahitya/gdsl-exchange-api.git
cd gdsl-exchange-api
cp .env.example .env
npm install
npm run db:migrate
npm run dev    # http://localhost:4000/health
```

---

## 1. Database export (production)

You will receive a plain connection string like:

```text
postgresql://postgres:PASSWORD@127.0.0.1:5433/cryptoflow
```

**SSH to the server** (team lead adds your public key first):

```bash
ssh root@157.245.100.175
```

**Export on the server:**

```bash
pg_dump 'postgresql://postgres:PASSWORD@127.0.0.1:5433/cryptoflow' --no-owner --no-acl > cryptoflow_backup.sql
```

Or if you already have SSH:

```bash
grep DATABASE_URL /opt/trade_bot/.env
# use with pg_dump; replace postgres:5432 → 127.0.0.1:5433 if needed
```

---

## 2. API layout

| Path | Purpose |
|------|---------|
| `apps/api/src/index.ts` | Thin boot |
| `apps/api/src/server/createApp.ts` | Express + middleware |
| `apps/api/src/server/registerRoutes.ts` | All `/api/*` routers |
| `apps/api/src/server/socketServer.ts` | **Socket.IO — your main file** |
| `apps/api/src/server/backgroundJobs.ts` | Watchers, intervals |
| `apps/api/src/routes/*.ts` | HTTP handlers |
| `apps/api/src/services/**` | Business logic |
| `packages/db/prisma/schema.prisma` | Database schema |

---

## 3. WebSockets — already exist

Extend `apps/api/src/server/socketServer.ts`. Emit from routes via `getSocketIo()` in `apps/api/src/lib/realtimeHub.ts`.

| Event | Direction |
|-------|-----------|
| `trade:executed` | server → client |
| `trade:failed` | server → client |
| `performance:update` | server → client |
| `portfolio:update` | server → client |
| `cex-sm:trade` | server → client |
| `positions:refresh` | server → client |

---

## 4. High traffic — suggested approach

1. Profile `/metrics` and logs for 429/503 routes
2. Move hot polling to Socket.IO
3. Extend caching on read-heavy endpoints
4. Do not touch hot wallet signing or live execution without approval

---

## 5. Deploy

Merge to `main` → **Build API image** workflow → `ghcr.io/madhusahitya/gdsl-exchange-api:latest`

Production site: [trade.godslandx.com](https://trade.godslandx.com)
