#!/bin/sh
set -e
cd /app/packages/db
npx prisma migrate deploy
cd /app
exec node apps/api/dist/index.js
