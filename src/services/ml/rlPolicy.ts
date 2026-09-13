/**
 * RL Policy inference with hot-reload support.
 *
 * Model resolution order (first found wins):
 *   1. /models/champion.onnx  — shared volume, promoted by modelPromotion service
 *   2. ./models/dqn-v1.onnx  — bundled in Docker image at build time
 *
 * Hot-reload: call rlPolicy.reload() after promotion to swap the ONNX session
 * without restarting the API process.
 *
 * Action space: 0=HOLD, 1=BUY, 2=SELL
 *
 * State vector (order must match training/train_loop.py STATE_COLS):
 *   [ema20Rel, ema50Rel, rsi14_norm, macdHist_norm, bbPos,
 *    atr14Rel, volRatio_norm, obi, newsSentiment, positionFlag,
 *    unrealizedPnlPct, barsInPosition]
 *
 * volRatio_norm = clip(vol / rolling20mean, 0, 5) / 5  → range [0, 1]
 */
import path from 'path'
import fs from 'fs'
import { prisma } from '@cryptoflow/db'
import { logger } from '../../lib/logger'
import { env } from '../../lib/env'
import { featureEngine } from '../market/featureEngine'
import { orderBookService } from '../market/orderBook'

export type RLAction = 'HOLD' | 'BUY' | 'SELL'
const ACTION_MAP: RLAction[] = ['HOLD', 'BUY', 'SELL']

export interface RLPrediction {
  action:     RLAction
  qValues:    number[]
  confidence: number
  shadow:     boolean
  modelPath:  string
}

// Model paths — shared volume takes priority
const CHAMPION_PATH  = '/models/champion.onnx'
const FALLBACK_PATH  = path.join(process.cwd(), 'models', 'dqn-v1.onnx')

function resolveModelPath(): string | null {
  if (fs.existsSync(CHAMPION_PATH)) return CHAMPION_PATH
  if (fs.existsSync(FALLBACK_PATH)) return FALLBACK_PATH
  return null
}

// Mutable session state — swapped on hot-reload
let _session: import('onnxruntime-node').InferenceSession | null = null
let _onnx:    typeof import('onnxruntime-node') | null = null
let _modelPath: string | null = null
let _initDone = false

async function initSession(): Promise<void> {
  if (_initDone) return
  _initDone = true
  await _loadSession()
}

async function _loadSession(): Promise<void> {
  const modelPath = resolveModelPath()
  if (!modelPath) {
    logger.info('[rl] No ONNX model found — using rule-based fallback')
    return
  }
  try {
    if (!_onnx) _onnx = await import('onnxruntime-node')
    _session   = await _onnx.InferenceSession.create(modelPath)
    _modelPath = modelPath
    logger.info(`[rl] Loaded model from ${modelPath}`)
  } catch (err) {
    logger.warn({ err }, '[rl] Failed to load ONNX model — using fallback')
    _session = null
  }
}

/** Hot-reload: call after model promotion to swap session in-place */
export async function reload(): Promise<void> {
  logger.info('[rl] Hot-reloading model...')
  _session   = null
  _modelPath = null
  await _loadSession()
  logger.info(`[rl] Hot-reload complete — active model: ${_modelPath ?? 'fallback'}`)
}

export function getActiveModelPath(): string | null {
  return _modelPath
}

/** Build the normalised state vector from DB features */
async function buildStateVector(
  symbol: string,
  positionFlag: number,
  unrealizedPnlPct: number,
  barsInPosition: number,
): Promise<Float32Array> {
  const f   = await featureEngine.getLatest(symbol, '1h') ?? {}
  const obi = orderBookService.getOBI(symbol) ?? 0

  const since = new Date(Date.now() - 6 * 60 * 60 * 1000)
  const news  = await prisma.newsEvent.findMany({
    where: { publishedAt: { gte: since } },
    select: { sentimentScore: true },
  })
  const newsSentiment = news.length > 0
    ? news.reduce((s, n) => s + Number(n.sentimentScore), 0) / news.length
    : 0

  return new Float32Array([
    clamp((f.ema20Rel ?? 0) * 100, -5, 5),
    clamp((f.ema50Rel ?? 0) * 100, -5, 5),
    ((f.rsi14 ?? 50) - 50) / 50,
    clamp((f.macdHist ?? 0), -100, 100) / 100,
    (f.bbPos ?? 0.5) * 2 - 1,
    clamp((f.atr14Rel ?? 0) * 100, 0, 5) / 5,
    clamp((f.volRatio ?? 1), 0, 5) / 5,
    obi,
    clamp(newsSentiment, -1, 1),
    positionFlag,
    clamp(unrealizedPnlPct, -0.1, 0.1) / 0.1,
    Math.min(barsInPosition / 24, 1),
  ])
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function fallbackDecision(stateVec: Float32Array, pUp?: number): { action: RLAction; qValues: number[] } {
  const positionFlag = stateVec[9]
  const p = pUp ?? 0.5
  if (p > 0.62 && positionFlag === 0) return { action: 'BUY',  qValues: [0.2, 0.8, 0.1] }
  if (p < 0.38 && positionFlag === 1) return { action: 'SELL', qValues: [0.2, 0.1, 0.8] }
  return { action: 'HOLD', qValues: [0.8, 0.2, 0.1] }
}

export async function predictAction(
  symbol:           string,
  positionFlag:     number,
  unrealizedPnlPct: number,
  barsInPosition:   number,
  pUpHint?:         number,
): Promise<RLPrediction> {
  await initSession()

  const stateVec  = await buildStateVector(symbol, positionFlag, unrealizedPnlPct, barsInPosition)
  const shadowMode = env.ENABLE_RL_SHADOW !== 'false'

  let action: RLAction
  let qValues: number[]

  if (_session && _onnx) {
    const inp = new _onnx.Tensor('float32', stateVec, [1, stateVec.length])
    const out  = await _session.run({ state: inp })
    const raw  = Array.from(out['qvalues'].data as Float32Array)
    const idx  = raw.indexOf(Math.max(...raw))
    qValues = raw
    action  = ACTION_MAP[idx] ?? 'HOLD'
  } else {
    const fb = fallbackDecision(stateVec, pUpHint)
    action   = fb.action
    qValues  = fb.qValues
  }

  const qMax       = Math.max(...qValues)
  const qSum       = qValues.reduce((a, b) => a + Math.exp(b), 0)
  const confidence = Math.exp(qMax) / qSum

  const stateHash = Buffer.from(stateVec.buffer).toString('base64').slice(0, 16)
  const modelId   = _modelPath ? path.basename(_modelPath, '.onnx') : 'fallback'

  await prisma.modelPrediction.create({
    data: {
      modelId,
      version:    _modelPath ?? 'fallback',
      symbol,
      ts:         new Date(),
      action,
      qValues,
      confidence,
      stateHash,
      shadow:     shadowMode,
    },
  }).catch(() => {})

  return { action, qValues, confidence, shadow: shadowMode, modelPath: _modelPath ?? 'fallback' }
}
