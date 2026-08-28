// sessions.mjs - one saved game per Telegram chat, plus the timers behind them.
//
// The browser prototype had a single global session and a single global timer.
// A bot has many players at once, so both are keyed by chat id. Sessions are one
// JSON file each: no database yet, and at prototype scale the whole store is a
// few hundred kilobytes.
//
// The rules in game.mjs still hold no timers of their own. A handler that wants
// to be called back returns {schedule:{kind,ms}} and this file owns the clock -
// which also means a schedule of null must never cancel a pending one, or a
// player typing during their own run would stop it dead.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as game from './game.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_DIR = process.env.MW_STATE_DIR || resolve(HERE, 'state')

const live = new Map()      // chatId -> session
const timers = new Map()    // chatId -> timeout handle

const fileFor = (chatId) => join(STATE_DIR, `${chatId}.json`)

/**
 * Bring an older saved game up to date in place.
 *
 * Runs used to hold no exit point and no start time, because every position ran
 * to the end of the circuit on a fixed timer. A player mid-round when that
 * changed keeps their position and exits where they would have anyway.
 */
function migrate (S) {
  if (!S) return
  if (S.budget === undefined) {
    // one persistent bankroll became a daily allowance. There is no honest way
    // to carry a bankroll across: keeping the old figure as the balance would
    // start them mid-day already down against a full budget, and bill the -5%
    // for a loss they took under the old rules. They start today level instead.
    S.budget = game.START_BUDGET
    S.balance = game.START_BUDGET
    S.dayIndex = 0
    S.dayStartedMs = Date.now()
    S.investedToday = 0
    S.week = []
    S.bonus = 0
    delete S.money
  }
  if (!S.run) return
  if (S.run.exitAt === undefined) {
    S.run.exitAt = Math.max(S.run.investAt + 1, (S.world?.readouts ?? 8) - 1)
  }
  if (S.run.startedMs === undefined) {
    // treat the readouts already delivered as though they arrived on schedule
    S.run.startedMs = Date.now()
    S.run.investAt = S.run.revealed
  }
}

export async function load (chatId) {
  if (live.has(chatId)) return live.get(chatId)
  const path = fileFor(chatId)
  if (existsSync(path)) {
    try {
      const d = JSON.parse(await readFile(path, 'utf8'))
      if (d?.version === 3) {
        migrate(d.session)
        live.set(chatId, d.session)
        return d.session
      }
    } catch (e) {
      console.warn(`  ${chatId}: unreadable session, starting fresh (${e.message})`)
    }
  }
  return null
}

export async function save (chatId, S) {
  live.set(chatId, S)
  const { allWorlds, ...rest } = S      // the world list is re-fetched on boot
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(fileFor(chatId), JSON.stringify({ version: 3, session: rest }))
}

export function put (chatId, S) { live.set(chatId, S) }
export function forget (chatId) { live.delete(chatId); clearTimer(chatId) }

export async function allChatIds () {
  if (!existsSync(STATE_DIR)) return []
  const names = await readdir(STATE_DIR)
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5))
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

export function clearTimer (chatId) {
  const t = timers.get(chatId)
  if (t) { clearTimeout(t); timers.delete(chatId) }
}

export function hasTimer (chatId) { return timers.has(chatId) }

/**
 * Arm a callback for one chat. A null schedule is *not* a cancellation: it means
 * "nothing new to arm", so anything already pending keeps running.
 */
export function schedule (chatId, sched, fire) {
  if (!sched) return
  clearTimer(chatId)
  timers.set(chatId, setTimeout(() => {
    timers.delete(chatId)
    Promise.resolve(fire(sched)).catch((e) =>
      console.error(`  ${chatId}: scheduled work failed:`, e.message))
  }, sched.ms))
}

/** A run or a wait should always have a timer behind it; re-arm if it does not. */
export function ensureTimer (chatId, S, fire) {
  if (timers.has(chatId)) return
  if (S.expect === 'running' && S.run) {
    schedule(chatId, { kind: 'step', ms: game.STEP_MS }, fire)
  }
}

/** On boot, pick up every session that was mid-run when the process stopped. */
export async function resumeAll (fireFor) {
  const ids = await allChatIds()
  let resumed = 0
  for (const chatId of ids) {
    const S = await load(chatId)
    if (!S) continue
    if (S.expect === 'running') {
      ensureTimer(chatId, S, fireFor(chatId))
      resumed += 1
    }
  }
  return { sessions: ids.length, resumed }
}
