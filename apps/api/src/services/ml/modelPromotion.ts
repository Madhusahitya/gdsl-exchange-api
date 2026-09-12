/**
 * Champion / challenger model promotion service.
 *
 * Every hour the API calls checkAndPromote():
 *   1. Looks for /models/candidate_metrics.json written by the trainer container
 *   2. Loads champion metrics from the ModelVersion DB table
 *   3. Compares: candidate must beat champion by PROMOTION_MARGIN on Sharpe
 *      AND satisfy hard gates (maxDrawdown, winRate)
 *   4. If promoted:
 *      - Archive champion ONNX to /models/archive/champion-{timestamp}.onnx
 *      - Copy candidate.onnx → champion.onnx
 *      - Call rlPolicy.reload() (hot-swap without restart)
 *      - Persist ModelVersion records
 *      - Prune archive to last MAX_ARCHIVE_COUNT models
 *   5. If rejected: log and delete candidate files
 *
 * Promotion gates (conservative — prevent noise-driven swaps):
 *   - candidate.sharpe > champion.sharpe × PROMOTION_MARGIN
 *   - candidate.maxDrawdown < MAX_DRAWDOWN
 *   - candidate.winRate >= MIN_WIN_RATE
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { reload as reloadRLPolicy } from './rlPolicy'

const MODELS_DIR         = '/models'
const ARCHIVE_DIR        = path.join(MODELS_DIR, 'archive')
const CHAMPION_ONNX      = path.join(MODELS_DIR, 'champion.onnx')
const CANDIDATE_ONNX     = path.join(MODELS_DIR, 'candidate.onnx')
const CANDIDATE_METRICS  = path.join(MODELS_DIR, 'candidate_metrics.json')

const PROMOTION_MARGIN   = 1.05   // candidate Sharpe must be 5% better
const MAX_DRAWDOWN       = 0.25   // 25% max drawdown gate
const MIN_WIN_RATE       = 0.47   // at least 47% win rate
const MAX_ARCHIVE_COUNT  = 3      // keep last N archived models

export interface ModelMetrics {
  sharpe:      number
  sortino:     number
  winRate:     number
  maxDrawdown: number
  profitFactor:number
  totalReturn: number
  episodes:    number
  modelId:     string
  trainedAt:   string
}

function readCandidateMetrics(): ModelMetrics | null {
  if (!fs.existsSync(CANDIDATE_METRICS)) return null
  try {
    return JSON.parse(fs.readFileSync(CANDIDATE_METRICS, 'utf-8')) as ModelMetrics
  } catch {
    return null
  }
}

async function getChampionMetrics(): Promise<ModelMetrics | null> {
  const row = await prisma.modelVersion.findFirst({
    where: { status: 'champion' },
    orderBy: { promotedAt: 'desc' },
  })
  if (!row) return null
  return {
    sharpe:       row.sharpe       ?? 0,
    sortino:      row.sortino      ?? 0,
    winRate:      row.winRate      ?? 0,
    maxDrawdown:  row.maxDrawdown  ?? 1,
    profitFactor: row.profitFactor ?? 1,
    totalReturn:  row.totalReturn  ?? 0,
    episodes:     row.episodes     ?? 0,
    modelId:      row.modelId,
    trainedAt:    row.trainedAt.toISOString(),
  }
}

function pruneArchive() {
  if (!fs.existsSync(ARCHIVE_DIR)) return
  const files = fs.readdirSync(ARCHIVE_DIR)
    .filter((f) => f.endsWith('.onnx'))
    .map((f) => ({ f, t: fs.statSync(path.join(ARCHIVE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)  // newest first

  // Delete files beyond MAX_ARCHIVE_COUNT
  files.slice(MAX_ARCHIVE_COUNT).forEach(({ f }) => {
    fs.unlinkSync(path.join(ARCHIVE_DIR, f))
    logger.info(`[promotion] Pruned old model archive: ${f}`)
  })
}

function cleanupCandidate() {
  if (fs.existsSync(CANDIDATE_ONNX))    fs.unlinkSync(CANDIDATE_ONNX)
  if (fs.existsSync(CANDIDATE_METRICS)) fs.unlinkSync(CANDIDATE_METRICS)
}

export async function checkAndPromote(): Promise<void> {
  const candidate = readCandidateMetrics()
  if (!candidate) return  // no candidate ready

  logger.info(`[promotion] Candidate available: sharpe=${candidate.sharpe.toFixed(3)} ` +
              `dd=${(candidate.maxDrawdown * 100).toFixed(1)}% ` +
              `winRate=${(candidate.winRate * 100).toFixed(1)}%`)

  // Hard gates
  if (candidate.maxDrawdown > MAX_DRAWDOWN) {
    logger.warn(`[promotion] Rejected: maxDrawdown ${(candidate.maxDrawdown * 100).toFixed(1)}% > ${MAX_DRAWDOWN * 100}%`)
    await logRejection(candidate, `maxDrawdown too high: ${candidate.maxDrawdown.toFixed(3)}`)
    cleanupCandidate()
    return
  }
  if (candidate.winRate < MIN_WIN_RATE) {
    logger.warn(`[promotion] Rejected: winRate ${(candidate.winRate * 100).toFixed(1)}% < ${MIN_WIN_RATE * 100}%`)
    await logRejection(candidate, `winRate too low: ${candidate.winRate.toFixed(3)}`)
    cleanupCandidate()
    return
  }

  const champion = await getChampionMetrics()

  if (champion) {
    const requiredSharpe = champion.sharpe * PROMOTION_MARGIN
    if (candidate.sharpe <= requiredSharpe) {
      logger.info(
        `[promotion] Rejected: candidate sharpe ${candidate.sharpe.toFixed(3)} ≤ ` +
        `required ${requiredSharpe.toFixed(3)} (champion ${champion.sharpe.toFixed(3)} × ${PROMOTION_MARGIN})`
      )
      await logRejection(candidate, `sharpe ${candidate.sharpe.toFixed(3)} didn't beat champion ${champion.sharpe.toFixed(3)} × ${PROMOTION_MARGIN}`)
      cleanupCandidate()
      return
    }
  } else {
    // No champion yet — promote any passing candidate
    logger.info('[promotion] No champion in DB — promoting first passing candidate')
  }

  // ─── Promote ───────────────────────────────────────────────────
  if (!fs.existsSync(CANDIDATE_ONNX)) {
    logger.warn('[promotion] candidate.onnx missing — cannot promote')
    cleanupCandidate()
    return
  }

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true })

  // Archive current champion if it exists
  if (fs.existsSync(CHAMPION_ONNX) && champion) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const archiveName = `champion-${ts}.onnx`
    fs.copyFileSync(CHAMPION_ONNX, path.join(ARCHIVE_DIR, archiveName))

    await prisma.modelVersion.updateMany({
      where: { status: 'champion' },
      data:  { status: 'archived', archivedAt: new Date() },
    })
    logger.info(`[promotion] Archived champion as ${archiveName}`)
  }

  // Copy candidate → champion
  fs.copyFileSync(CANDIDATE_ONNX, CHAMPION_ONNX)

  // Persist new champion record
  await prisma.modelVersion.create({
    data: {
      modelId:     candidate.modelId,
      status:      'champion',
      sharpe:      candidate.sharpe,
      sortino:     candidate.sortino,
      winRate:     candidate.winRate,
      maxDrawdown: candidate.maxDrawdown,
      profitFactor:candidate.profitFactor,
      totalReturn: candidate.totalReturn,
      episodes:    candidate.episodes,
      promotedAt:  new Date(),
      notes: champion
        ? `Replaced ${champion.modelId} (sharpe ${champion.sharpe.toFixed(3)} → ${candidate.sharpe.toFixed(3)})`
        : 'First champion',
    },
  })

  cleanupCandidate()
  pruneArchive()

  // Hot-reload the RL policy session
  await reloadRLPolicy()

  logger.info(
    `[promotion] ✓ Promoted ${candidate.modelId} ` +
    `sharpe=${candidate.sharpe.toFixed(3)} ` +
    `dd=${(candidate.maxDrawdown * 100).toFixed(1)}% ` +
    `winRate=${(candidate.winRate * 100).toFixed(1)}%`
  )
}

async function logRejection(m: ModelMetrics, reason: string) {
  await prisma.modelVersion.create({
    data: {
      modelId:     m.modelId,
      status:      'rejected',
      sharpe:      m.sharpe,
      sortino:     m.sortino,
      winRate:     m.winRate,
      maxDrawdown: m.maxDrawdown,
      profitFactor:m.profitFactor,
      totalReturn: m.totalReturn,
      episodes:    m.episodes,
      notes:       reason,
    },
  }).catch(() => {})
}
