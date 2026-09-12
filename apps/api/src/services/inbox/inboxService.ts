import { prisma, InboxCategory, type Prisma } from '@cryptoflow/db'

export type InboxMessageDto = {
  id: string
  category: InboxCategory
  title: string
  body: string
  metadata: Record<string, unknown> | null
  readAt: string | null
  createdAt: string
}

function toDto(row: {
  id: string
  category: InboxCategory
  title: string
  body: string
  metadata: Prisma.JsonValue | null
  readAt: Date | null
  createdAt: Date
}): InboxMessageDto {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    metadata: row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>) : null,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listInboxMessages(
  userId: string,
  opts: { take: number; unreadOnly?: boolean },
): Promise<InboxMessageDto[]> {
  const rows = await prisma.inboxMessage.findMany({
    where: {
      userId,
      ...(opts.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, opts.take)),
  })
  return rows.map(toDto)
}

export async function unreadInboxCount(userId: string): Promise<number> {
  return prisma.inboxMessage.count({
    where: { userId, readAt: null },
  })
}

export async function markInboxRead(userId: string, id: string): Promise<boolean> {
  const r = await prisma.inboxMessage.updateMany({
    where: { id, userId },
    data: { readAt: new Date() },
  })
  return r.count > 0
}

export async function markAllInboxRead(userId: string): Promise<number> {
  const r = await prisma.inboxMessage.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  })
  return r.count
}

export async function recentDedupeExists(userId: string, dedupeKey: string, windowMs: number): Promise<boolean> {
  const since = new Date(Date.now() - windowMs)
  const hit = await prisma.inboxMessage.findFirst({
    where: { userId, dedupeKey, createdAt: { gte: since } },
    select: { id: true },
  })
  return hit != null
}

export async function createInboxMessage(input: {
  userId: string
  category: InboxCategory
  title: string
  body: string
  metadata?: Prisma.InputJsonValue
  dedupeKey?: string | null
}): Promise<InboxMessageDto> {
  const row = await prisma.inboxMessage.create({
    data: {
      userId: input.userId,
      category: input.category,
      title: input.title.slice(0, 220),
      body: input.body,
      metadata: input.metadata ?? undefined,
      dedupeKey: input.dedupeKey ?? undefined,
    },
  })
  return toDto(row)
}

/** Best-effort cap so the table does not grow without bound for active users. */
export async function pruneOldInboxMessages(userId: string, keepLatest: number): Promise<void> {
  const keep = Math.min(2000, Math.max(200, keepLatest))
  const rows = await prisma.inboxMessage.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
    skip: keep,
    take: 500,
  })
  if (rows.length === 0) return
  await prisma.inboxMessage.deleteMany({
    where: { userId, id: { in: rows.map((r) => r.id) } },
  })
}
