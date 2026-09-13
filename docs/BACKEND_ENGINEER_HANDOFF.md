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

Health check: http://localhost:4000/health

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

Main entry: `apps/api/src/index.ts` (thin boot)

Your area for WebSockets / traffic work:

- `apps/api/src/server/socketServer.ts` — start here
- `apps/api/src/server/registerRoutes.ts` — all routes mounted here
- `apps/api/src/lib/realtimeHub.ts` — emit events from routes with `getSocketIo()`

Routes are split under `apps/api/src/routes/`. Business logic in `apps/api/src/services/`. DB schema in `packages/db/prisma/schema.prisma`.

Socket.IO is already wired — extend it, don't rebuild from scratch. Events already going out: `trade:executed`, `trade:failed`, `performance:update`, `portfolio:update`, `cex-sm:trade`, `positions:refresh`.

---

## What I need you to focus on

We're hitting API failures and too much polling under load. Profile first (`/metrics`, logs, which routes 429/503), then move hot paths to sockets instead of HTTP polling where it makes sense.

Don't touch hot wallet signing, live Jupiter/Binance execution, or prod `.env` without checking with me first.

---

## Deploy

Push to `main` on this repo. The `gdsl-exchange` repo's GitHub Action builds the docker image and deploys to the droplet. Image: `ghcr.io/madhusahitya/gdsl-exchange-api:latest`.

Ping me if you're stuck.
