#!/usr/bin/env node
import { runDemoTrade } from './demoRun'

runDemoTrade().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.log(
    JSON.stringify({
      event: 'trade.fatal',
      timestamp: new Date().toISOString(),
      reason: msg,
    })
  )
  process.exitCode = 1
})
