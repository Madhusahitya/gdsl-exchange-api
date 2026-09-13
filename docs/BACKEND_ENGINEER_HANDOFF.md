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

## 1. SSH access (production server)

| Field | Value |
|-------|--------|
| **Host** | `157.245.100.175` |
| **User** | `root` |
| **Port** | `22` (default) |
| **App path on server** | `/opt/trade_bot` |
| **Production URL (web)** | https://trade.godslandx.com |
| **Production URL (API + WebSocket)** | https://api.godslandx.com |
| **WebSocket URL** | `wss://api.godslandx.com` |

**Login (after your public key is added):**

```bash
ssh root@157.245.100.175
```

**First time setup on your laptop** — generate a key if you don't have one:

```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
cat ~/.ssh/id_ed25519.pub
```

Send the **`.pub` file contents** to the team lead (Signal/WhatsApp). They add it to the server; you do **not** need a password if key auth is set up.

**Useful commands once logged in:**

```bash
cd /opt/trade_bot
docker compose ps                    # api, web, postgres status
docker compose logs -f api --tail 100
grep DATABASE_URL .env               # DB connection (internal Docker URL)
curl -s http://127.0.0.1:4000/health # API health on the host
```

---

## 2. Database export (production)

You will receive a plain connection string (from team lead):

```text
postgresql://postgres:PASSWORD@127.0.0.1:5433/cryptoflow
```

**SSH in first**, then export:

```bash
ssh root@157.245.100.175
pg_dump 'postgresql://postgres:PASSWORD@127.0.0.1:5433/cryptoflow' --no-owner --no-acl > cryptoflow_backup.sql
```

Or read the URL from the server:

```bash
grep DATABASE_URL /opt/trade_bot/.env
# for pg_dump on the host, use 127.0.0.1:5433 instead of postgres:5432
```

---

## 3. API layout

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

## 4. WebSockets — already exist

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

## 5. High traffic — suggested approach

1. Profile `/metrics` and logs for 429/503 routes
2. Move hot polling to Socket.IO
3. Extend caching on read-heavy endpoints
4. Do not touch hot wallet signing or live execution without approval

---

## 6. Deploy

Merge to `main` → **Build API image** workflow → `ghcr.io/madhusahitya/gdsl-exchange-api:latest`

Production:
- Web: [trade.godslandx.com](https://trade.godslandx.com)
- API: [api.godslandx.com/health](https://api.godslandx.com/health)

**SSL:** Let's Encrypt on the droplet (auto-renew). No separate SSL login — use HTTPS URLs above.
