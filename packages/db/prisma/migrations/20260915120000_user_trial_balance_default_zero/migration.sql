-- Align DB default with schema.prisma (@default(0)); existing rows unchanged.
ALTER TABLE "User" ALTER COLUMN "trialBalance" SET DEFAULT 0;
