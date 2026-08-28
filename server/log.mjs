// log.mjs - one JSON object per line, for answering "how would this scale?"
//
// The console output is for a person watching a boot. This is for afterwards:
// every turn, model call, render and error, with timings, so `npm run stats`
// can say where the time actually went rather than where it seemed to.
//
// Writes are appended synchronously. That is a real cost - a few hundred
// microseconds - but it means a line written just before a crash is on disk,
// which is the whole point of having it.
//
//   MW_LOG_FILE   default ./events.jsonl, empty string disables
//   MW_LOG_MAX    rotate to .1 past this many bytes (default 16MB)
//
// Lines contain chat ids, the same identifiers as the state directory, and
// should be handled the same way. Message text is never recorded.

import { appendFileSync, statSync, renameSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = process.env.MW_LOG_FILE === ''
  ? null
  : resolve(HERE, process.env.MW_LOG_FILE || './events.jsonl')
const MAX = Number(process.env.MW_LOG_MAX || 16 * 1024 * 1024)

let broken = false

function rotate () {
  try {
    if (!existsSync(FILE) || statSync(FILE).size < MAX) return
    renameSync(FILE, `${FILE}.1`)
  } catch { /* a log that cannot rotate must not stop the game */ }
}

/** Append one event. Never throws: logging must not be able to break a turn. */
export function logEvent (event, fields = {}) {
  if (!FILE || broken) return
  try {
    rotate()
    appendFileSync(FILE, JSON.stringify({ ts: Date.now(), event, ...fields }) + '\n')
  } catch (e) {
    broken = true      // say so once, then stop trying
    console.warn(`  logging disabled: ${e.message}`)
  }
}

/** Time an async call and log it. Returns what the call returned. */
export async function timed (event, fields, fn) {
  const t0 = process.hrtime.bigint()
  const ms = () => Number(process.hrtime.bigint() - t0) / 1e6
  try {
    const value = await fn()
    logEvent(event, { ...fields, ms: Math.round(ms()), ok: true })
    return value
  } catch (e) {
    logEvent(event, { ...fields, ms: Math.round(ms()), ok: false, error: e.message })
    throw e
  }
}

export const logFile = () => FILE
