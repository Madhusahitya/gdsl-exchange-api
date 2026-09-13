import { Router, Request, Response } from 'express'
import { asyncHandler } from '../middleware/asyncHandler'

const router = Router()

type MusicHit = {
  videoId: string
  title: string
  channelTitle: string
}

function extractMusicHits(html: string, max = 8): MusicHit[] {
  const hits: MusicHit[] = []
  const seen = new Set<string>()
  const re =
    /"videoId":"([a-zA-Z0-9_-]{11})".+?"title":\{"runs":\[\{"text":"([^"]+)".+?"ownerText":\{"runs":\[\{"text":"([^"]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && hits.length < max) {
    const videoId = m[1]
    if (seen.has(videoId)) continue
    seen.add(videoId)
    hits.push({
      videoId,
      title: m[2],
      channelTitle: m[3],
    })
  }
  return hits
}

router.get(
  '/search',
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').trim()
    if (!q) {
      res.status(400).json({ error: 'q is required' })
      return
    }
    const limit = Math.min(12, Math.max(1, parseInt(String(req.query.limit ?? '8'), 10) || 8))
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D`
    const response = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
      },
    })
    if (!response.ok) {
      res.status(502).json({ error: 'Failed to reach YouTube search' })
      return
    }
    const html = await response.text()
    const hits = extractMusicHits(html, limit)
    res.json({
      query: q,
      results: hits,
    })
  })
)

export default router
