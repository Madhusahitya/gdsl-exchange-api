# Backend handoff

Hey — this is the API repo. Don't clone `gdsl-exchange` for backend work; that's frontend only.

## Get running locally

```bash
git clone git@github.com:Madhusahitya/gdsl-exchange-api.git
cd gdsl-exchange-api
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

Health check (local dev): http://localhost:8000/health  
Production / Docker on the droplet: port **4000** (`http://127.0.0.1:4000/health`)

Fill in `.env` properly or stuff will break. Minimum you need:

- `DATABASE_URL`
- `JWT_SECRET`
- `ENCRYPTION_KEY`
- `WALLET_ENCRYPTION_KEY` — without this you'll get `{"error":"WALLET_ENCRYPTION_KEY not configured"}` on Jupiter wallet routes. Generate one for local dev:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste that into `.env`. Use your own key locally. Don't use production's unless I send you a DB dump and tell you to.

Docker works too if you prefer: `docker compose up --build` (same `.env`).

---

## SSH (production server)

Your key is already on the box. Just:

```bash
ssh root@157.245.100.175
```

App lives at `/opt/trade_bot`. Handy stuff once you're in:

```bash
cd /opt/trade_bot
docker compose ps
docker compose logs -f api --tail 100
curl -s http://127.0.0.1:4000/health
```

Live site: https://trade.godslandx.com  
API subdomain (SSL going up once DNS is done): https://api.godslandx.com  
WebSockets: `wss://api.godslandx.com`

---

## Database

I'll send you the connection string on Signal separately.

SSH in, then:

```bash
pg_dump 'postgresql://postgres:PASSWORD@127.0.0.1:5433/cryptoflow' --no-owner --no-acl > cryptoflow_backup.sql
```

Or just `grep DATABASE_URL /opt/trade_bot/.env` on the server. Port is **5433** on the host.

---

## Docker / GHCR

We don't use Docker Hub. Prod images are on GitHub (`ghcr.io/madhusahitya/gdsl-exchange-api` and `-web`).

For your day-to-day work, just build locally — don't bother pulling prod images.

If you're on the server over SSH, docker is already logged in. No extra credentials needed.

If you really need to pull images on your laptop (you probably don't), ping me and I'll send a GitHub token with `read:packages`. Login like:

```bash
echo 'TOKEN' | docker login ghcr.io -u Madhusahitya --password-stdin
```

---

## Where the code is

<<<<<<< HEAD
| Path | Purpose |
|------|---------|
| `src/index.ts` | Thin boot |
| `src/server/createApp.ts` | Express + middleware |
| `src/server/registerRoutes.ts` | All `/api/*` routers |
| `src/server/socketServer.ts` | **Socket.IO — your main file** |
| `src/server/backgroundJobs.ts` | Watchers, intervals |
| `src/routes/*.ts` | HTTP handlers |
| `src/services/**` | Business logic |
| `packages/db/prisma/schema.prisma` | Database schema |
=======
Main entry: `apps/api/src/index.ts`

- `apps/api/src/server/socketServer.ts` — Socket.IO
- `apps/api/src/server/registerRoutes.ts` — routes
- `apps/api/src/lib/realtimeHub.ts` — `getSocketIo()` for emitting from routes
- `apps/api/src/routes/` — HTTP handlers
- `apps/api/src/services/` — business logic
- `packages/db/prisma/schema.prisma` — DB schema

Socket events in use: `trade:executed`, `trade:failed`, `performance:update`, `portfolio:update`, `cex-sm:trade`, `positions:refresh`.
>>>>>>> 82f036891d50867fdf64816cede5a792b38e5e5c

---

## Deploy

<<<<<<< HEAD
Extend `src/server/socketServer.ts`. Emit from routes via `getSocketIo()` in `src/lib/realtimeHub.ts`.

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
=======
Push to `main`. The `gdsl-exchange` repo's GitHub Action builds the image and deploys. Image: `ghcr.io/madhusahitya/gdsl-exchange-api:latest`.
>>>>>>> 82f036891d50867fdf64816cede5a792b38e5e5c
