#!/bin/sh
set -e
cd /app/packages/db
npx prisma migrate deploy
cd /app
exec node dist/index.js
