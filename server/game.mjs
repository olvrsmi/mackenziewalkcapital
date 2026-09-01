// game.mjs - the rules of Office 4B, 6 Mackenzie Walk.
//
// A port of the terminal prototype's state machine. The server owns this; the
// model owns the physics. Input is short terminal-style tokens for now (an LLM
// goes in front of it later), so `expect` says what the next token means.
//
// Emissions are objects the client renders: {kind:'text'} for chat lines and
// {kind:'traces'|'gatemap'} for visuals, which the client draws itself rather
// than receiving images.

import { callModel } from './model.mjs'
import { gameSeconds, realMs, describeGame, describeReal, GAME_DAY_SECONDS }
  from './time.mjs'
import { t, list, holding, moment } from './copy.mjs'

export const READOUTS = 8

// Two clocks, deliberately separate. Readouts come due on a GAME-time schedule,
// so retuning MW_TIME_SCALE retunes the physics with it. Messages go out on a
// REAL clock boundary, so everyone's news lands at the same moment. One post can
// therefore cover several readouts, or none.
export const READOUT_GAME_SECONDS =
  Number(process.env.MW_READOUT_GAME_SECONDS || 3600)   // a game hour apiece
// How often the news goes out, in GAME seconds - so it follows MW_TIME_SCALE
// like everything else, and a post carries exactly one readout at any speed.
// Setting it in real milliseconds was a trap: retuning the scale left posting
// where it was, and posting faster than the circuit moves means repeating a
// reading the player has already been given.
export const POST_GAME_SECONDS =
  Number(process.env.MW_POST_GAME_SECONDS || READOUT_GAME_SECONDS)
// MW_POST_MS pins the real interval instead, ignoring the scale. An escape
// hatch, not the normal dial.
export const POST_MS = process.env.MW_POST_MS
  ? Number(process.env.MW_POST_MS)
  : Math.round(realMs(POST_GAME_SECONDS))
export const STEP_MS = POST_MS                          // kept for the scheduler
export const START_BUDGET = Number(process.env.MW_START_BUDGET || 1000)
export const BUDGET_FLOOR = Number(process.env.MW_BUDGET_FLOOR || 500)
export const BUDGET_UP = 1.10          // after a profitable day
export const BUDGET_DOWN = 0.95        // after a loss, or a day spent idle
export const WEEK_DAYS = 7
export const WEEK_BONUS = Number(process.env.MW_WEEK_BONUS || 100)
export const UPGRADE_COST = Number(process.env.MW_UPGRADE_COST || 10)

// The economy runs in GAME seconds; time.mjs decides how fast those pass.
// Free regeneration restores a spent qubit over about eight game hours, and a
// purchased unit adds a quarter of that rate for 1G per game day.
export const FULL_RECHARGE_GAME_SECONDS =
  Number(process.env.MW_RECHARGE_GAME_SECONDS || 8 * 3600)
export const BASE_REGEN = 1 / FULL_RECHARGE_GAME_SECONDS   // per game second
export const REGEN_UNIT = BASE_REGEN * 0.25                // per game second
export const DAY_SECONDS = GAME_DAY_SECONDS                // game seconds

// `|| 0` collapses negative zero, which would otherwise print as "-0G"
const money = (v) => `${(Math.round(v) || 0).toLocaleString('en-GB')}G`

/**
 * The technical facts of a circuit, said as a market would say them.
 *
 * The complexity words come from copy.yaml and the bands are derived from how
 * many there are, so a writer can add or remove one without touching thresholds.
 */
export function prospectus (info) {
  const words = list('vocabulary.complexity')
  const band = words.findIndex((_, i) => info.gates < 15 * Math.pow(3.2, i + 1))
  const complexity = words[band === -1 ? words.length - 1 : band] || 'unknown'
  const monopoly = Math.round(100 * info.pairs.length / Math.max(1, info.max_pairs))
  const volatility = Math.round(100 * (info.volatility ?? 0) / 2)
  return {
    opportunities: info.n,
    complexity,
    monopoly,
    volatility,
    line: `${info.n} investment opportunit${info.n === 1 ? 'y' : 'ies'} · ` +
          `${complexity} · ${monopoly}% corporate monopolisation · ` +
          `${volatility}% expected volatility`,
  }
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const norm = (v) => Math.hypot(v[0], v[1], v[2])

export function newSession (seed = Date.now()) {
  // begins at Z = 1 with X and Y randomised, at full coherence
  let s = seed >>> 0
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const v = [rnd() * 2 - 1, rnd() * 2 - 1, 1]
  const r = norm(v)
  return {
    version: 2,
    seed,
    direction: v.map((x) => x / r),
    coherence: 1,
    // The budget is the day's allowance and the number that compounds; the
    // balance is what is left of it right now. Anything unspent is lost when the
    // day turns, so there is no saving across days.
    budget: START_BUDGET,
    balance: START_BUDGET,
    dayIndex: 0,
    dayStartedMs: Date.now(),
    investedToday: 0,
    week: [],                 // the last seven days' results
    bonus: 0,                 // personal, cannot be staked
    history: [START_BUDGET],
    rounds: 0,
    regenUnits: 0,
    clockMs: Date.now(),
    expect: 'boot',
    worlds: null,          // the three on offer
    world: null,           // the one entered
    clean: null,           // scouted clean run
    readoutIndex: 0,
    pending: null,         // {stake} while choosing a target
    run: null,             // {investAt, target, stake, z, apparatus, coherence, revealed}
  }
}

export function bloch (S) {
  return S.direction.map((d) => d * S.coherence)
}

export function regenRate (S) {
  return BASE_REGEN + S.regenUnits * REGEN_UNIT
}

/** What one more increment of regeneration costs, bought outright. */
export const upgradeCost = () => UPGRADE_COST

// ---------------------------------------------------------------------------
// The clock: coherence returns, the subscription bills. Both accrue against
// real elapsed seconds, so time spent reading, waiting or running all counts.
// ---------------------------------------------------------------------------

export function tick (S, nowMs = Date.now()) {
  const elapsed = gameSeconds(Math.max(0, nowMs - S.clockMs))   // game seconds
  S.clockMs = nowMs

  const before = S.coherence
  S.coherence = Math.min(1, S.coherence + regenRate(S) * elapsed)
  return { elapsed, gained: S.coherence - before }
}

/** Would a position closing at this point run past the end of the day? */
export function crossesDayEnd (S, exitAt, nowMs = Date.now()) {
  const steps = exitAt - S.readoutIndex
  return steps * READOUT_GAME_SECONDS > dayRemaining(S, nowMs)
}

/** The furthest exit point still reachable before the day ends. */
export function lastReachable (S, nowMs = Date.now()) {
  const steps = Math.floor(dayRemaining(S, nowMs) / READOUT_GAME_SECONDS)
  return Math.max(S.readoutIndex + 1,
    Math.min(S.readoutIndex + steps, S.world.readouts - 1))
}

/** Game seconds left of the current day. */
export function dayRemaining (S, nowMs = Date.now()) {
  return Math.max(0, GAME_DAY_SECONDS - gameSeconds(nowMs - S.dayStartedMs))
}

export const dayIsOver = (S, nowMs = Date.now()) => dayRemaining(S, nowMs) <= 0

/**
 * Close the day and set tomorrow's allowance.
 *
 * Breaking even counts as a good day so long as something was staked; a day
 * with nothing staked is treated as a loss, so sitting out costs you. The floor
 * means a run of bad days cannot spiral - the budget stops at BUDGET_FLOOR.
 */
export function closeDay (S) {
  const pl = S.balance - S.budget
  const traded = S.investedToday > 0
  const good = traded && pl >= 0

  const next = Math.max(BUDGET_FLOOR,
    Math.round(S.budget * (good ? BUDGET_UP : BUDGET_DOWN)))

  S.week.push(pl)
  let bonusPaid = 0
  let weekTotal = null
  if (S.week.length >= WEEK_DAYS) {
    weekTotal = S.week.reduce((a, b) => a + b, 0)
    if (weekTotal > 0) { S.bonus += WEEK_BONUS; bonusPaid = WEEK_BONUS }
    S.week = []
  }

  const wasBudget = S.budget
  S.budget = next
  S.balance = next
  S.dayIndex += 1
  S.dayStartedMs = Date.now()
  S.investedToday = 0
  S.history.push(S.balance)

  return { pl, traded, good, wasBudget, next, bonusPaid, weekTotal,
           day: S.dayIndex }
}

function tickLines (elapsed) {
  const bits = []
  if (elapsed.gained > 0.0005) bits.push(`coherence +${elapsed.gained.toFixed(3)}`)

  const out = []
  if (bits.length) {
    out.push(t('scenes.time_passed',
      { elapsed: describeGame(elapsed.elapsed), gained: bits.join(', ') }))
  }
  return out
}


// ---------------------------------------------------------------------------
// What the client shows in its HUD, and what it should let the player type
// ---------------------------------------------------------------------------

export function hud (S) {
  const b = bloch(S)
  const rate = regenRate(S)
  return {
    kind: 'state',
    expect: S.expect,
    round: S.rounds + 1,
    bloch: { X: +b[0].toFixed(3), Y: +b[1].toFixed(3), Z: +b[2].toFixed(3) },
    coherence: +S.coherence.toFixed(3),
    money: Math.round(S.balance),
    regenRate: +rate.toFixed(4),
    regenUnits: S.regenUnits,
    budget: Math.round(S.budget),
    bonus: Math.round(S.bonus),
    dayIndex: S.dayIndex,
    daySeconds: DAY_SECONDS,
    secondsToFull: S.coherence >= 0.999 ? 0 : Math.round((1 - S.coherence) / rate),
    history: S.history.map((v) => Math.round(v)),
    world: S.world ? { name: S.world.name, id: S.world.info.id, n: S.world.info.n }
                   : null,
    readoutIndex: S.readoutIndex,
    readouts: S.world ? S.world.readouts : null,
    busy: S.expect === 'running' || S.expect === 'holding',
  }
}

const text = (t) => ({ kind: 'text', text: t })

function tracesPanel (S, upto, opts = {}) {
  return {
    kind: 'traces',
    n: S.world.info.n,
    holdings: S.world.holdings,
    cuts: S.clean.cuts,
    z: (opts.z || S.clean.z).slice(0, upto + 1),
    upto,
    totalReadouts: S.world.readouts,
    target: opts.target ?? null,
    interventionAt: opts.interventionAt ?? null,
    title: opts.title || t('plots.traces_title',
      { world: S.world.name, moment: moment(upto), progress: upto }),
  }
}

function gatemapPanel (S) {
  return {
    kind: 'gatemap',
    n: S.world.info.n,
    holdings: S.world.holdings,
    layers: S.clean.layers,
    cuts: S.clean.cuts,
    nLayers: S.clean.n_layers,
    pairs: S.world.info.pairs,
    title: t('plots.gatemap_title', {
      world: S.world.name, gates: S.world.info.gates,
      layers: S.clean.n_layers,
    }),
  }
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

export function sceneMain (S) {
  const recovering = S.coherence < 0.999
  return [text(t('scenes.round', {
    round: S.rounds + 1,
    coherence: S.coherence.toFixed(3),
    coherence_raw: S.coherence,
    recovering,
    recovery: recovering
      ? describeReal((1 - S.coherence) / regenRate(S)) : '',
    balance: money(S.balance),
    balance_raw: S.balance,
    budget: money(S.budget), budget_raw: S.budget,
    bonus: money(S.bonus), bonus_raw: S.bonus,
    has_bonus: S.bonus > 0,
    day: S.dayIndex + 1,
    day_left: describeReal(dayRemaining(S)),
    pl: `${S.balance - S.budget >= 0 ? '+' : ''}${money(S.balance - S.budget)}`,
    pl_raw: S.balance - S.budget,
    upgrades: S.regenUnits,
  }))]
}

export function offerWorlds (S, rnd) {
  const pool = S.allWorlds
  if (!pool) throw new Error('offerWorlds: no world list — call hydrate(S) first')
  const picks = []
  const used = new Set()
  while (picks.length < 3 && used.size < pool.length) {
    const i = Math.floor(rnd() * pool.length)
    if (used.has(i)) continue
    used.add(i)
    picks.push(pool[i])
  }
  // names must be distinct within an offer, or two worlds read as the same place
  const names = []
  while (names.length < picks.length) {
    const names_ = list('worlds')
    const n = names_[Math.floor(rnd() * names_.length)]
    if (!names.includes(n)) names.push(n)
  }
  // Each world's holdings get tickers, distinct across the whole offer so the
  // same three letters never mean two things among the worlds on the table.
  const tickers = list('holdings')
  const taken = new Set()
  S.worlds = picks.map((info, i) => {
    const holdings = []
    while (holdings.length < info.n && taken.size < tickers.length) {
      const h = tickers[Math.floor(rnd() * tickers.length)]
      if (taken.has(h)) continue
      taken.add(h)
      holdings.push(h)
    }
    return { info, name: names[i], readouts: info.readouts, holdings }
  })
  S.expect = 'world'
  return [text(t('scenes.offer'))]
}

export function sceneInvestment (S) {
  const k = S.readoutIndex
  S.expect = 'invest'
  const out = []
  if (k === 0) out.push(gatemapPanel(S))
  out.push(tracesPanel(S, k))
  out.push(text(t('scenes.investment', {
    world: S.world.name,
    moment: moment(k),
    progress: k,
    total: S.world.readouts - 1,
    coherence: S.coherence.toFixed(3),
    coherence_raw: S.coherence,
    balance: money(S.balance),
    balance_raw: S.balance,
    last_chance: k === S.world.readouts - 2,
  })))
  return out
}

export function sceneMarket (S) {
  S.expect = 'market'

  return [text(t('scenes.marketplace', {
    recharge: describeReal(1 / BASE_REGEN),
    unit_cost: money(UPGRADE_COST),
    coherence: S.coherence.toFixed(3), coherence_raw: S.coherence,
    balance: money(S.balance), balance_raw: S.balance,
    units: S.regenUnits,
    recovering: S.coherence < 0.999,
    recovery: S.coherence < 0.999
      ? describeReal((1 - S.coherence) / regenRate(S)) : '',
    upgrades: S.regenUnits,
    budget: money(S.budget), budget_raw: S.budget,
    bonus: money(S.bonus), bonus_raw: S.bonus,
  }))]
}

// ---------------------------------------------------------------------------
// The command handler. Short tokens for now; `expect` gives each its meaning.
//
// Returns {emissions, schedule} where schedule, if present, asks the server to
// come back later: {kind:'step'|'hold', ms}. The server owns all timers so the
// rules stay free of them.
// ---------------------------------------------------------------------------

/**
 * Fill in the world list, which is deliberately not saved with the session.
 *
 * Every path that can reach offerWorlds must call this first, including the
 * timer path: a session resumed mid-run after a restart has no list, and the
 * run ending is exactly when it needs one.
 */
export async function hydrate (S) {
  if (S.allWorlds) return S
  const w = await callModel({ op: 'worlds', readouts: READOUTS })
  S.allWorlds = w.worlds
  S.skipped = w.skipped.length
  return S
}

export async function boot (S) {
  await hydrate(S)
  const rnd = mulberry(S.seed + S.rounds * 7919)
  return {
    emissions: [
      text(t('scenes.welcome', {
        worlds: S.allWorlds.length,
        skipped: S.skipped,
        recharge: describeReal(1 / BASE_REGEN),
      })),
      ...sceneMain(S),
      ...offerWorlds(S, rnd),
    ],
  }
}

function mulberry (a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const num = (s) => {
  const v = Number(String(s).replace(/[, gG]/g, ''))
  return Number.isFinite(v) ? v : null
}

/**
 * Handle one token.
 *
 * `emit` is optional and lets a slow handler answer before it is finished:
 * entering a world spends about a second in the model, which is a long silence
 * after tapping a button. Anything passed to emit goes out immediately; what is
 * returned follows when the work is done.
 */
export async function handle (S, raw, emit = null) {
  const elapsed = tick(S)
  const pre = tickLines(elapsed).map(text)
  // nothing is open here, so the books can be closed straight away
  if (S.expect !== 'running' && dayIsOver(S)) pre.push(...endOfDay(S))
  let preSent = false
  const out = (...e) => ({ emissions: [...(preSent ? [] : pre), ...e.flat()] })
  const cmd = String(raw || '').trim().toLowerCase()

  if (!cmd) return out(text(t('prompts.say_something')))
  if (cmd === 'help' || cmd === '?') return out(text(t('prompts.help')))
  if (cmd === 'state' || cmd === 'status') return out(sceneMain(S))

  switch (S.expect) {
    case 'running':
    case 'holding':
      return out(text(t('chatter')))

    case 'world': {
      if (cmd === 'm') return out(sceneMarket(S))
      const i = num(cmd)
      if (![1, 2, 3].includes(i)) {
        return out(text(t('prompts.unknown',
          { options: '**1**, **2** or **3**, or **m**' })))
      }
      S.world = S.worlds[i - 1]
      S.expect = 'scouting'
      // acknowledge the tap before going to the model, not after
      const pr = prospectus(S.world.info)
      const entered = text(t('scenes.entered', {
        world: S.world.name,
        opportunities: pr.opportunities,
        complexity: pr.complexity,
        monopoly: pr.monopoly,
        volatility: pr.volatility,
        disconnected: !S.world.info.connected,
      }))
      if (emit) {
        preSent = true
        await emit([...pre, entered])
      }
      const scout = await callModel({
        op: 'scout', circuit: S.world.info.id, readouts: READOUTS,
        direction: S.direction, coherence: S.coherence,
      })
      S.clean = scout
      S.world.readouts = scout.cuts.length
      S.readoutIndex = 0
      return preSent ? out(sceneInvestment(S)) : out(entered, sceneInvestment(S))
    }

    case 'invest': {
      // leaving is free only before anything has been committed - one look at
      // the ground and you are in until the round is over
      if (cmd === 'l' && S.readoutIndex === 0) {
        S.world = null
        S.clean = null
        const rnd = mulberry(S.seed + S.rounds * 7919)
        return out(text(t('scenes.left')), sceneMain(S), offerWorlds(S, rnd))
      }
      if (cmd === 'o' || cmd === 'w') {
        S.readoutIndex += 1
        if (S.readoutIndex > S.world.readouts - 2) {
          return out(text(t('scenes.observed_all')), ...endRound(S))
        }
        return out(sceneInvestment(S))
      }
      if (cmd !== 'i') {
        return out(text(t('prompts.unknown', {
          options: '**i** to invest · **o** to observe' +
            (S.readoutIndex === 0 ? ' · **l** to leave' : ''),
        })))
      }
      if (S.balance < 1) return out(text(t('scenes.nothing_to_stake')))
      S.expect = 'stake'
      return out(text(t('scenes.ask_stake', { balance: Math.floor(S.balance) })))
    }

    case 'stake': {
      const v = num(cmd)
      if (v === null || v < 1) {
        S.expect = 'invest'
        return out(text(t('prompts.unknown',
          { options: '**i** to try again or **o** to observe' })))
      }
      S.pending = { stake: clamp(Math.round(v), 1, Math.floor(S.balance)) }
      S.expect = 'target'
      return out(text(t('scenes.ask_target', { last: S.world.info.n - 1 })))
    }

    case 'target': {
      const q = num(cmd)
      if (q === null || q < 0 || q >= S.world.info.n || !Number.isInteger(q)) {
        return out(text(t('scenes.ask_target', { last: S.world.info.n - 1 })))
      }
      S.pending.target = q
      S.expect = 'exit'
      const last = S.world.readouts - 1
      return out(text(t('scenes.take_profit', {
        world: S.world.name, target: q, holding: holding(q, S.world.holdings),
        moment: moment(S.readoutIndex), progress: S.readoutIndex,
        first: moment(S.readoutIndex + 1), last: moment(last),
      })))
    }

    case 'exit': {
      const exitAt = num(cmd)
      const last = S.world.readouts - 1
      if (exitAt === null || !Number.isInteger(exitAt) ||
          exitAt <= S.readoutIndex || exitAt > last) {
        return out(text(t('scenes.ask_exit',
          { first: moment(S.readoutIndex + 1), last: moment(last) })))
      }
      // The day closes every position, so an exit beyond the bell would be cut
      // short. Say so before the money is committed, and offer a way back.
      if (crossesDayEnd(S, exitAt) && !S.pending.confirmed) {
        S.pending.exitAt = exitAt
        S.expect = 'confirm_exit'
        return out(text(t('scenes.exit_past_bell', {
          exit: moment(exitAt), remaining: describeReal(dayRemaining(S)),
          reachable: moment(lastReachable(S)),
        })))
      }
      S.pending.confirmed = false
      const q = S.pending.target
      const stake = S.pending.stake
      S.pending = null
      S.balance -= stake
      S.investedToday += 1
      if (emit) {
        preSent = true
        await emit([...pre, text(t('scenes.staking', { stake: money(stake), target: q, holding: holding(q, S.world.holdings) }))])
      }
      const play = await callModel({
        op: 'play', circuit: S.world.info.id, readouts: READOUTS,
        invest_at: S.readoutIndex, target: q,
        direction: S.direction, coherence: S.coherence,
      })
      // `reported` starts at the entry point: the position_open message and the
      // panel below it already show that reading, so the first post has news
      // only once the circuit has actually moved.
      S.run = { investAt: S.readoutIndex, target: q, stake, exitAt, ...play,
                revealed: S.readoutIndex, reported: S.readoutIndex,
                // the run keeps its own copy: settle names the holding after
                // the round has ended and S.world has moved on
                holdings: S.world.holdings, startedMs: Date.now() }
      S.expect = 'running'
      return {
        emissions: [...(preSent ? [] : pre),
          ...(preSent ? [] : [text(t('scenes.staking', { stake: money(stake), target: q, holding: holding(q, S.world.holdings) }))]),
          text(t('scenes.position_open', { target: q, holding: holding(q, S.world.holdings),
                 exit: moment(exitAt), every: postEvery() })),
          stepPanel(S)],
        schedule: { kind: 'step', ms: msUntilNextPost() },
      }
    }

    case 'confirm_exit': {
      if (cmd === 'y' || cmd === 'yes') {
        S.pending.confirmed = true
        S.expect = 'exit'
        return handle(S, String(S.pending.exitAt), emit)
      }
      S.expect = 'exit'
      return out(text(t('scenes.ask_exit', {
        first: moment(S.readoutIndex + 1),
        last: moment(S.world.readouts - 1),
      })))
    }

    case 'market': {
      if (cmd === 'l') { const rnd = mulberry(S.seed + S.rounds * 7919)
                         return out(sceneMain(S), offerWorlds(S, rnd)) }
      if (cmd === 'b') { S.expect = 'buy'; return out(text(t('scenes.ask_units'))) }
      return out(text(t('prompts.unknown', { options: '**b** or **l**' })))
    }

    case 'buy': {
      const k = num(cmd)
      if (k === null || k < 1) return out(sceneMarket(S))
      const want = Math.floor(k)
      const afford = Math.min(want, Math.floor(S.balance / UPGRADE_COST))
      if (afford < 1) {
        return out(text(t('scenes.cannot_afford',
          { cost: money(UPGRADE_COST), balance: money(S.balance) })),
          sceneMarket(S))
      }
      S.balance -= afford * UPGRADE_COST
      S.regenUnits += afford
      return out(text(t('scenes.upgraded', {
        bought: afford, spent: money(afford * UPGRADE_COST),
        upgrades: S.regenUnits, recovery: describeReal(1 / regenRate(S)),
      })), sceneMarket(S))

    }

    default:
      return out(text(t('prompts.nothing_to_decide')))
  }
}

// ---------------------------------------------------------------------------
// The run: one readout released every STEP_MS, then the returns
// ---------------------------------------------------------------------------

function stepPanel (S) {
  const r = S.run
  const k = Math.min(r.revealed, r.exitAt)
  const z0 = r.z[r.investAt][r.target]
  return tracesPanel(S, k, {
    z: r.z, target: r.target, interventionAt: r.investAt,
    title: t('plots.traces_running', {
      world: S.world.name, target: r.target, holding: holding(r.target, r.holdings),
      change: pct((r.z[k][r.target] - z0) / 2),
    }),
  })
}

/** How often reports land, said plainly - the interval is configurable. */
export function postEvery () {
  const s = POST_MS / 1000
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`
}

/** The next real-clock boundary, so every player's report lands together. */
export function msUntilNextPost (now = Date.now()) {
  return POST_MS - (now % POST_MS) || POST_MS
}

/** How many readouts have come due by now, capped at where the position closes. */
function dueIndex (S, now = Date.now()) {
  const elapsed = gameSeconds(now - S.run.startedMs)
  const advanced = Math.floor(elapsed / READOUT_GAME_SECONDS)
  return Math.min(S.run.investAt + advanced, S.run.exitAt)
}

/**
 * A scheduled post. Releases every readout that has come due since the last one
 * and reports them together, so a post can cover several - or none, when the
 * clock has turned but the circuit has not.
 */
export function step (S, now = Date.now()) {
  const r = S.run
  if (!r) return { emissions: [], done: true }

  // The bell closes every position where it stands, whatever exit was chosen.
  if (dayIsOver(S, now)) {
    const at = Math.min(dueIndex(S, now), r.exitAt)
    r.revealed = at
    r.exitAt = at
    r.forced = true
    // the bell closes the position, then the books, and only then offers
    // the next round - which must read the new day's budget
    return { emissions: [...settle(S, { closeRound: false }),
                         ...endOfDay(S), ...endRound(S)], done: true }
  }

  const due = dueIndex(S, now)
  const from = r.revealed + 1
  if (due < from) {
    // Nothing has come due. Posts are aligned to the wall clock while readouts
    // run from the moment of investment, so the first post of a round can land
    // in the gap before t+1 - and repeating a reading the player already has
    // is worse than a short silence. They were told the reporting interval
    // when the position opened.
    if (r.reported === r.revealed) {
      return { emissions: [], schedule: { kind: 'step', ms: msUntilNextPost(now) },
               done: false }
    }
    r.reported = r.revealed
    return {
      emissions: [(() => {
        const m = (r.z[r.revealed][r.target] - r.z[r.investAt][r.target]) / 2
        return text(t('scenes.readout', {
          world: S.world.name, target: r.target, holding: holding(r.target, r.holdings),
          moment: moment(r.revealed),
          value: fmt(r.z[r.revealed][r.target]),
          value_raw: r.z[r.revealed][r.target],
          change: pct(m), change_raw: m, arrow: '→',
          pl: `${Math.round(r.stake * m) > 0 ? '+' : ''}${money(r.stake * m)}`,
          pl_raw: r.stake * m,
        }))
      })()],
      schedule: { kind: 'step', ms: msUntilNextPost(now) },
      done: false,
    }
  }

  r.revealed = due
  r.reported = due
  const z0 = r.z[r.investAt][r.target]
  const rows = []
  for (let k = from; k <= due; k++) {
    const z = r.z[k][r.target]
    const prev = r.z[k - 1][r.target]
    const arrow = z > prev + 1e-6 ? '↗' : (z < prev - 1e-6 ? '↘' : '→')
    const mult = (z - z0) / 2
    rows.push(t('scenes.readout', {
      world: S.world.name, target: r.target, holding: holding(r.target, r.holdings),
      moment: moment(k),
      value: fmt(z), value_raw: z,
      change: pct(mult), change_raw: mult, arrow,
      pl: `${Math.round(r.stake * mult) > 0 ? '+' : ''}${money(r.stake * mult)}`,
      pl_raw: r.stake * mult,
    }))
  }
  const emissions = [{ ...stepPanel(S), caption: rows.join('\n') }]

  if (due >= r.exitAt) return { emissions: [...emissions, ...settle(S)], done: true }
  return { emissions, schedule: { kind: 'step', ms: msUntilNextPost(now) },
           done: false }
}

const fmt = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`
const pct = (m) => `${m >= 0 ? '+' : ''}${(m * 100).toFixed(1)}%`

/** The returns scene, then back to the main scene. */
function settle (S, { closeRound = true } = {}) {
  const r = S.run
  const z0 = r.z[r.investAt][r.target]
  const z1 = r.z[r.exitAt][r.target]
  const dz = z1 - z0
  const mult = dz / 2
  // the stake was taken when the coupling was made; it comes back scaled by
  // (1 + multiplier), so a worst call loses it all and a best call doubles it
  // rounded to whole G: the day's P/L is balance - budget, and a float here
  // makes an apparently flat day settle a hair under and bill the -5%
  const returned = Math.round(r.stake * (1 + mult))
  const profit = returned - r.stake
  S.balance = Math.max(0, S.balance + returned)

  const before = S.coherence
  const fr = norm(r.apparatus)
  if (fr > 1e-9) S.direction = r.apparatus.map((x) => x / fr)
  S.coherence = clamp(fr, 0, 1)

  const out = [{ kind: 'text', text: t('scenes.returns', {
    target: r.target, holding: holding(r.target, r.holdings),
    opened_at: z0.toFixed(4), closed_at: z1.toFixed(4),
    exit: moment(r.exitAt),
    change: `${dz >= 0 ? '+' : ''}${dz.toFixed(4)}`, change_raw: dz,
    multiplier: `${mult >= 0 ? '+' : ''}${mult.toFixed(4)}`, multiplier_raw: mult,
    stake: money(r.stake), stake_raw: r.stake,
    returned: money(returned), returned_raw: returned,
    profit: `${profit >= 0 ? '+' : ''}${money(profit)}`, profit_raw: profit,
    outcome: profit >= 0 ? 'profit' : 'loss',
    balance: money(S.balance), balance_raw: S.balance,
    flat: Math.abs(dz) < 1e-6,
    forced: !!r.forced,
    coherence: S.coherence.toFixed(3), was_coherence: before.toFixed(3),
    drained: S.coherence < before - 0.3,
  }) }]

  S.run = null
  return closeRound ? [...out, ...endRound(S)] : out
}

/** Close the books, pay any weekly bonus, and hand out tomorrow's budget. */
export function endOfDay (S) {
  const r = closeDay(S)
  const out = [text(t('scenes.day_end', {
    day: r.day,
    pl: `${r.pl >= 0 ? '+' : ''}${money(r.pl)}`, pl_raw: r.pl,
    good: r.good, traded: r.traded, idle: !r.traded,
    was_budget: money(r.wasBudget), budget: money(r.next),
    change: r.good ? '+10%' : '-5%',
    floored: r.next === BUDGET_FLOOR,
    floor: money(BUDGET_FLOOR),
  }))]
  if (r.weekTotal !== null) {
    out.push(text(t('scenes.week_end', {
      total: `${r.weekTotal >= 0 ? '+' : ''}${money(r.weekTotal)}`,
      total_raw: r.weekTotal,
      paid: r.bonusPaid > 0,
      bonus: money(r.bonusPaid),
      pot: money(S.bonus),
    })))
  }
  return out
}

function endRound (S) {
  S.rounds += 1
  S.world = null
  S.clean = null
  S.readoutIndex = 0
  if (S.balance < 1) {
    S.expect = 'over'
    return [{ kind: 'text', text: t('scenes.broke') }]
  }
  const rnd = mulberry(S.seed + S.rounds * 7919)
  return [...sceneMain(S), ...offerWorlds(S, rnd)]
}


