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

import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as game from './game.mjs'
import { logEvent } from './log.mjs'
import { list } from './copy.mjs'

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
    if (S.run?.stake) {
      // the stake was taken under the old rules and will be returned under the
      // new ones. Take it out of today's budget too, or settling pays it twice.
      S.balance -= S.run.stake
      S.investedToday = 1
    }
  }
  // Worlds used to have no tickers, and a saved game mid-round would otherwise
  // read E0/E1 until the next round came round. Assigned from the name so the
  // same world keeps the same letters between restarts.
  const tickers = list('holdings')
  if (tickers.length) {
    // distinct across the offer, as offerWorlds does it, or two worlds on the
    // same table would show the same three letters for different holdings
    const taken = new Set((S.worlds || []).flatMap((w) => w.holdings || []))
    for (const w of S.worlds || []) {
      if (w.holdings) continue
      let h = 0
      for (const c of w.name || '') h = (h * 31 + c.charCodeAt(0)) % tickers.length
      w.holdings = []
      for (let i = 0; w.holdings.length < (w.info?.n ?? 0) && i < tickers.length * 2; i++) {
        const pick = tickers[(h + i) % tickers.length]
        if (taken.has(pick)) continue
        taken.add(pick)
        w.holdings.push(pick)
      }
    }
    const held = (S.worlds || []).find((w) => w.name === S.world?.name)
    if (S.world && !S.world.holdings) S.world.holdings = held?.holdings
    if (S.run && !S.run.holdings) S.run.holdings = S.world?.holdings
    // a position open across the pricing change has no pinned listing
    // price; recover it from the world rather than quoting NaN
    if (S.run && S.run.base === undefined && S.world?.info) {
      S.run.base = game.basePrice(S.world.info, S.run.target)
    }
  }

  // A desk that existed before probation did has already proved itself.
  if (S.probation === undefined) {
    S.probation = false
    S.attempts = 1
  }
  // A save from before beats existed has seen none of them - but it is also
  // past probation, so none are due either.
  // A save from before scenes existed has played none - but it has also long
  // since been past the intro, so it is marked as seen rather than replayed at
  // someone who has been trading for a week.
  S.seq ??= null
  // Every opening scene, not just the intro: a player who has been trading for
  // a week should not suddenly be walked to their desk because a scene was
  // added after they started.
  S.seqSeen ??= S.rounds > 0 ? list('opening') : []
  S.vars ??= {}
  S.beatsSeen ??= []
  S.beat ??= null
  S.unlocked ??= []

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
      if (d?.version !== 3) {
        logEvent('session_lost', { chat: chatId, why: 'version', found: d?.version })
      }
      if (d?.version === 3) {
        migrate(d.session)
        live.set(chatId, d.session)
        return d.session
      }
    } catch (e) {
      console.warn(`  ${chatId}: unreadable session, starting fresh (${e.message})`)
      logEvent('session_lost', { chat: chatId, why: 'unparseable', error: e.message })
    }
  }
  return null
}

export async function save (chatId, S) {
  live.set(chatId, S)
  const { allWorlds, ...rest } = S      // the world list is re-fetched on boot
  await mkdir(STATE_DIR, { recursive: true })
  // Write beside the real file and rename over it. writeFile truncates in
  // place, so a crash mid-write leaves a half-written save that will not parse
  // - and the player silently starts a new game. rename is atomic on POSIX.
  const path = fileFor(chatId)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 3, session: rest }))
  await rename(tmp, path)
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

/**
 * Every session should have a wake behind it, not only the ones mid-run.
 *
 * A day has to close on the clock whether or not the player is watching, so the
 * timer is no longer "the next readout" but "whenever this session next needs
 * anything" - the sooner of its day boundary and its next post. Whatever fires
 * works out what is due and arms the next one.
 */
export function ensureTimer (chatId, S, fire) {
  if (timers.has(chatId)) return
  schedule(chatId, { kind: 'wake', ms: game.nextWake(S) }, fire)
}

/**
 * On boot, arm every saved session.
 *
 * It used to be only the ones mid-run, because a timer only ever meant "the next
 * readout". Now a session with no position still has a day ending, so a restart
 * that skipped it would leave that day open until the player happened to speak.
 */
export async function resumeAll (fireFor) {
  const ids = await allChatIds()
  let resumed = 0
  for (const chatId of ids) {
    const S = await load(chatId)
    if (!S) continue
    ensureTimer(chatId, S, fireFor(chatId))
    resumed += 1
  }
  return { sessions: ids.length, resumed }
}
