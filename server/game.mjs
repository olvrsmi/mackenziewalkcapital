// game.mjs - the rules of Office 4B, 6 Mackenzie Walk.
//
// A port of the terminal prototype's state machine. The server owns this; the
// model owns the physics. Input is short terminal-style tokens for now (an LLM
// goes in front of it later), so `expect` says what the next token means.
//
// Emissions are objects the client renders: {kind:'text'} for chat lines and
// {kind:'traces'} for visuals, which the client draws itself rather
// than receiving images.

import { callModel } from './model.mjs'
import { gameSeconds, realMs, describeGame, describeReal, GAME_DAY_SECONDS }
  from './time.mjs'
import { t, list, section, render, holding, moment } from './copy.mjs'

// How many times a world is stepped. A specification has no natural end - it
// would keep being applied forever - so this is the whole answer to "how long
// is a round", and it is meant to be turned while testing. One step produces
// one readout, so t0..t{STEPS-1}.
export const STEPS = Number(process.env.MW_STEPS || 10)

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
// What the house requires of a day before it counts as a good one, as a
// fraction of that day's budget.
export const QUOTA = Number(process.env.MW_QUOTA || 0.10)
export const WEEK_DAYS = 7
// A new desk is on probation until it has posted a profitable week. Failing
// means starting the week again, not leaving.
export const PROBATION = process.env.MW_PROBATION !== '0'
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
  // How much the specification asks of the world: the number of Pauli
  // correlations it drives every step. Gate count used to carry this, but a
  // specification's "gates" are just its targets times the step count, which
  // barely varies between worlds - every one of them would read as simple.
  const asked = info.constraints ?? info.gates ?? 0
  const band = words.findIndex((_, i) => asked < 4 * Math.pow(1.45, i + 1))
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
/**
 * Each holding, said the way a market sheet says it.
 *
 * Three facts, and deliberately not a fourth. What it costs, how heavily it is
 * contracted, and who it is exposed to - all true, and none of them says how far
 * it will move. That last figure exists (per_qubit_range) and is the answer to
 * the only question the player is really asking, so the sheet does not carry it.
 * It is found by watching, which is what the readouts are for.
 *
 * The banding words come from copy.yaml and the thresholds are derived from how
 * many there are, so a writer adds or removes a word and the bands re-space
 * themselves - the same contract as the complexity band above.
 */
export function overview (info, holdings) {
  const words = list('vocabulary.contracted')
  const books = info.book || []
  return Array.from({ length: info.n }, (_, q) => {
    const book = books[q] || 0
    // An absolute ladder, not a within-world one. Banded against the world's own
    // heaviest, a light two-holding specification reads as "bound hand and foot"
    // because something has to be the heaviest in it. Across the set a book runs
    // 0 to 12, and a light world should say so.
    let i = words.findIndex((_, k) => book < 2 * Math.pow(1.75, k))
    if (i === -1) i = words.length - 1
    const wired = (info.pairs || [])
      .filter(([a, b]) => a === q || b === q)
      .map(([a, b]) => holding(a === q ? b : a, holdings))
    return {
      holding: holding(q, holdings),
      price: money(basePrice(info, q)),
      price_raw: basePrice(info, q),
      contracted: words[i] || 'unknown',
      book_raw: book,
      exposure: wired.join(', '),
      exposed: wired.length > 0,
      exposure_count: wired.length,
    }
  })
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
    // a new desk has a week to prove itself before it is a desk
    probation: PROBATION,
    attempts: 1,
    seq: null,               // a scene in progress
    seqSeen: [],             // scenes played, so the intro plays once
    vars: {},                // whatever a scene asked the player for
    beatsSeen: [],           // a setpiece fires once, ever
    beat: null,              // a choice waiting to be answered
    unlocked: [],            // marketplace items a beat has opened up
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
  // The house does not congratulate you for breaking even. A day counts only if
  // it clears QUOTA of the budget it was given - which is also what stops the
  // ladder running away: inverted, 83% of days finish up, and +10%/-5% needs
  // roughly 35% of days to fail or budgets compound without limit.
  const quota = Math.round(S.budget * QUOTA)
  const traded = S.investedToday > 0
  const good = traded && pl >= quota

  const next = Math.max(BUDGET_FLOOR,
    Math.round(S.budget * (good ? BUDGET_UP : BUDGET_DOWN)))

  S.week.push(pl)
  let bonusPaid = 0
  let weekTotal = null
  let passed = null
  if (S.week.length >= WEEK_DAYS) {
    weekTotal = S.week.reduce((a, b) => a + b, 0)
    passed = weekTotal > 0
    // On probation the week is the test and the bonus is not yet on offer;
    // afterwards it is an ordinary week and pays as one.
    if (passed && !S.probation) { S.bonus += WEEK_BONUS; bonusPaid = WEEK_BONUS }
    S.week = []
  }

  const wasBudget = S.budget
  S.budget = next
  S.balance = next
  S.dayIndex += 1
  S.dayStartedMs = Date.now()
  S.investedToday = 0
  S.history.push(S.balance)

  // The verdict, if a week just ended on probation. A failure winds the desk
  // back to where it started - everything except the player's own qubit, which
  // is theirs rather than the firm's and carries whatever it has left.
  let verdict = null
  if (S.probation && weekTotal !== null) {
    verdict = passed ? 'passed' : 'failed'
    if (passed) {
      S.probation = false
    } else {
      S.attempts = (S.attempts || 1) + 1
      S.budget = START_BUDGET
      S.balance = START_BUDGET
      S.week = []
      S.history = []
    }
  }

  return { pl, traded, good, wasBudget, next, bonusPaid, weekTotal, verdict,
           attempt: S.attempts || 1,
           // attempts counts sittings and has already been bumped by the
           // failure above, so the first failure arrives as attempt 2. Saying
           // it as a count of failures instead means nothing downstream has to
           // remember that.
           failures: (S.attempts || 1) - 1,
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
    // What is drawn is the quote, not the reading. Inverted, a falling <Z>
    // is a rising price, so plotting the reading would send every line the
    // opposite way to the number printed beside it.
    priced: (opts.z || S.clean.z).slice(0, upto + 1).map(
      (row) => row.map((z, q) => quote(basePrice(S.world.info, q), z))),
    // the uncoupled run, for the ghost line behind a held holding: where the
    // price was going before the player touched it. Only sent while a position
    // is open, since there is nothing to compare against otherwise.
    clean: opts.z
      ? S.clean.z.slice(0, upto + 1).map(
          (row) => row.map((z, q) => quote(basePrice(S.world.info, q), z)))
      : null,
    upto,
    totalReadouts: S.world.readouts,
    target: opts.target ?? null,
    interventionAt: opts.interventionAt ?? null,
    title: opts.title || t('plots.traces_title',
      { world: S.world.name, moment: moment(upto), progress: upto }),
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
  // The listings ride on the entry message, which goes out before the model is
  // called, so the sheet fills the wait rather than arriving after it. And the
  // standing here is the caption on the plot it describes: one message, one
  // picture, one thing to read.
  return [{
    ...tracesPanel(S, k),
    caption: t('scenes.investment', {
      world: S.world.name,
      moment: moment(k),
      progress: k,
      total: S.world.readouts - 1,
      coherence: S.coherence.toFixed(3),
      coherence_raw: S.coherence,
      balance: money(S.balance),
      balance_raw: S.balance,
      last_chance: k === S.world.readouts - 2,
    }),
  }]
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
  const w = await callModel({ op: 'worlds', readouts: STEPS })
  S.allWorlds = w.worlds
  S.skipped = w.skipped.length
  return S
}

export async function boot (S) {
  await hydrate(S)
  // A first sitting plays the opening scenes instead of the welcome, and the
  // game waits behind them. The order is a copy edit: `opening` is a list, and
  // this walks it.
  //
  // Scenes are taken until one actually stops to ask something. A scene with
  // nothing to answer - the voice is four pages and no questions - plays
  // straight through and the next one follows in the same breath. Returning
  // after it instead left `expect` on a scene that had already finished, and
  // the rest of the opening waited for the player to say something to nobody.
  const opening = []
  for (const id of list('opening')) {
    if ((S.seqSeen || []).includes(id)) continue
    opening.push(...startSequence(S, id))
    if (inSequence(S)) {
      S.expect = 'sequence'
      return { emissions: opening }
    }
  }

  const rnd = mulberry(S.seed + S.rounds * 7919)
  return {
    emissions: [
      // whatever of the opening played straight through, before the game
      ...opening,
      // The intro is IN PLACE OF the welcome, not before it - so a player who
      // has been walked up to the desk is not then read the brochure. Skipping
      // the intro skips this too; `help` is where the rules live either way.
      ...(list('opening').some((id) => (S.seqSeen || []).includes(id))
        ? []
        : [text(t('scenes.welcome', {
            worlds: S.allWorlds.length,
            skipped: S.skipped,
            recharge: describeReal(1 / BASE_REGEN),
          }))]),
      ...sceneMain(S),
      ...offerWorlds(S, rnd),
      // day one has no day-close before it to ride on
      ...fireBeat(S),
    ],
  }
}

// ---------------------------------------------------------------------------
// Price
//
// A holding is a listed company. What it is WORTH comes from its book of
// business - how many Pauli correlations in the specification name it, which is
// how many contracts it is held to, every step, forever. What it TRADES at is
// that worth divided by however many shares happened to be issued when it
// listed, which is a historical accident and carries no information at all.
//
// Both halves earn their place. The book alone leaves twelve of the forty-six
// worlds pricing every holding identically - the small symmetric specifications
// treat their qubits the same way, so no characteristic can tell them apart -
// and the float is what separates them. It also does the job a real share price
// does: a price you cannot read a company's size off.
//
// The quote moves as exp(-SIGMA * <Z>). Inverted, because a world starts
// polarised at <Z> ~ +1 and decoheres toward zero, so -<Z> is the direction that
// rises: a distressed book recovering. Multiplicative, so a quote is positive
// for every possible reading and needs no clamp, floor or special case.
// ---------------------------------------------------------------------------

export const PRICE_SIGMA = Number(process.env.MW_PRICE_SIGMA || 0.5)
const PRICE_UNIT = Number(process.env.MW_PRICE_UNIT || 90)
// How hard the book is compressed into a price. The book runs 0 to 12 across
// the worlds, so left alone it spans thirteenfold and the dear holdings use the
// whole frame while the cheap ones crowd the floor. An exponent squashes that
// without reordering anything: 0.35 takes the widest world from 8.4x between
// its cheapest and dearest holding down to 2.3x, and the median world from 2.5x
// to 1.4x.
//
// Only the picture changes. A payout is stake x (1 + priceReturn(zIn, zOut)),
// which is a function of the readings alone - the base cancels - and a stake is
// what the player names rather than what a holding costs. So this is the shape
// of the chart and nothing else.
const PRICE_GAMMA = Number(process.env.MW_PRICE_GAMMA || 0.35)
const FLOAT_SPREAD = 1.3        // widest the issued float pulls a quote either way

/** The listing price of holding q: what it trades at when <Z> is zero. */
export function basePrice (info, q) {
  const book = (info.book && info.book[q]) || 0
  // the float: stable for a world forever, drawn from the id so it needs no
  // storage and survives every restart and migration
  let h = 0
  for (const c of `${info.id}:${q}`) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0
  const float = Math.exp((mulberry(h)() - 0.5) * 2 * Math.log(FLOAT_SPREAD))
  return PRICE_UNIT * Math.pow(1 + book, PRICE_GAMMA) * float
}

/** What holding q quotes at, given its reading. */
export function priceOf (info, q, z) {
  return quote(basePrice(info, q), z)
}

/** A quote from an already-known listing price. */
export function quote (base, z) {
  return base * Math.exp(-PRICE_SIGMA * z)
}

/**
 * The return on a stake held from one reading to another. The base cancels, so
 * a cheap holding and a dear one pay the same for the same percentage move -
 * which is why the quote cannot be used to pick a winner.
 */
export function priceReturn (zIn, zOut) {
  return Math.exp(PRICE_SIGMA * (zIn - zOut)) - 1
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
  // Every day that has ended, not just the most recent - a player returning
  // after an absence closes the whole gap. The wake timer normally gets there
  // first; this covers a bot that was down while the clock ran.
  if (S.expect !== 'running') pre.push(...catchUpDays(S).emissions)

  let preSent = false
  const out = (...e) => ({ emissions: [...(preSent ? [] : pre), ...e.flat()] })
  const cmd = String(raw || '').trim().toLowerCase()

  // A running scene has the floor. It answers first, and a command it does not
  // recognise gets a nudge rather than falling through to the game - unlike a
  // beat, which must never swallow one.
  if (inSequence(S)) {
    if (cmd === 'skip' || cmd === '/skip') {
      // the whole opening, not just the scene in front of them - otherwise
      // skipping is something you have to do once per scene
      endSequence(S)
      S.seqSeen = [...new Set([...(S.seqSeen || []), ...list('opening')])]
      return out(...(await boot(S)).emissions)
    }
    const said = answerSequence(S, cmd)
    if (said) {
      if (!inSequence(S)) return out(said, (await boot(S)).emissions)
      return out(said)
    }
    return out(text(t('prompts.scene_waiting')))
  }

  // A pending beat is answered before anything else looks at the command, and
  // does not touch `expect` - so it can be answered mid-position, and a command
  // that is not one of its choices falls through to the game untouched.
  const answered = answerBeat(S, cmd)
  if (answered) return out(answered)

  if (!cmd) return out(text(t('prompts.say_something')))
  // The voice again, then the keys. The voice says what the terminal is for and
  // never names a keystroke, so the list underneath is not a repeat of it.
  if (cmd === 'help' || cmd === '?') {
    return out(...narrate(S, HELP_SCENE), text(t('prompts.help')))
  }
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
        rows: overview(S.world.info, S.world.holdings)
          .map((h) => t('scenes.overview_row', h)).join('\n'),
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
        op: 'scout', circuit: S.world.info.id, readouts: STEPS,
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
        op: 'play', circuit: S.world.info.id, readouts: STEPS,
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
                holdings: S.world.holdings,
                // pinned, so the settle quotes what the open quoted even if the
                // world's structural data changes under a deploy mid-position
                base: basePrice(S.world.info, q),
                startedMs: Date.now() }
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
      change: pct(priceReturn(z0, r.z[k][r.target])),
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
    // inverted: a falling reading is a rising quote, so the arrow follows the
    // price the player watches, not the physics underneath it
    const arrow = z < prev - 1e-6 ? '↗' : (z > prev + 1e-6 ? '↘' : '→')
    const mult = priceReturn(z0, z)
    rows.push(t('scenes.readout', {
      world: S.world.name, target: r.target, holding: holding(r.target, r.holdings),
      moment: moment(k),
      value: money(quote(r.base, z)),
      value_raw: quote(r.base, z),
      reading: fmt(z), reading_raw: z,
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
  // The quote moved, and the settle pays what the quote did - anything else and
  // the screen is lying about the only number it asks the player to read. The
  // base cancels in the ratio, so a cheap holding and a dear one pay the same
  // for the same percentage move.
  const mult = priceReturn(z0, z1)
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
    opened_at: money(quote(r.base, z0)),
    closed_at: money(quote(r.base, z1)),
    opened_reading: z0.toFixed(4), closed_reading: z1.toFixed(4),
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
// ---------------------------------------------------------------------------
// Sequences
//
// A scripted scene: a list of nodes played in order, stopping wherever it wants
// something from the player. Everything up to that stop is sent in one burst,
// paced a beat apart, so nobody taps a button that has no decision behind it.
//
// A node may carry any of:
//
//   art       a picture from server/art - missing files are skipped, so a
//             writer can reference one before it is drawn
//   speaker   who is talking
//   text      what they say
//   choices   keyed a, b, c... - any number of them. Each has a label, and a
//             reply that plays before the sequence carries on: branches colour
//             the moment and rejoin, so there is no graph to keep in your head
//   ask       capture whatever the player types next into a named variable,
//             readable afterwards as {that_name}
//
// Choices and asks may carry the same two effects a beat may: a coherence delta
// and a marketplace unlock.
// ---------------------------------------------------------------------------

/** Begin a named sequence. Returns nothing if there is no such sequence. */
export function startSequence (S, id, vars = null) {
  const nodes = section(`sequences.${id}`)
  if (!Array.isArray(nodes) || !nodes.length) return []
  S.seq = { id, at: 0, awaiting: null, ...(vars ? { vars } : {}) }
  S.vars ??= {}
  return runSequence(S)
}

export const inSequence = (S) => Boolean(S.seq)

const seqNodes = (S) => section(`sequences.${S.seq.id}`) || []

/** The context every line in a sequence can read. */
const seqCtx = (S) => ({
  ...S.vars,
  budget: money(S.budget),
  coherence: S.coherence.toFixed(3),
  // Last, so a scene handed its own facts wins. They ride on S.seq rather than
  // S.vars because they belong to this playing of the scene - S.vars holds what
  // the player told us about themselves, and a week's numbers are not that.
  ...(S.seq && S.seq.vars),
})

/** One node, as emissions. A picture and a line travel as one message. */
function seqEmit (S, node, textKey) {
  const body = textKey ? render(textKey, seqCtx(S)) : null
  const speaker = node.speaker ? render(node.speaker, seqCtx(S)) : null
  const caption = body === null ? null
    : (speaker ? `**${speaker}**\n${body}` : body)
  if (node.art) return [{ kind: 'art', art: node.art, caption, pace: true }]
  return caption === null ? [] : [{ kind: 'text', text: caption, pace: true }]
}

/**
 * Play forward until the sequence wants something, or ends.
 *
 * Everything between stops goes at once. `awaiting` is what the next message
 * from the player will mean - a choice, or the answer to an ask.
 */
export function runSequence (S) {
  const out = []
  const nodes = seqNodes(S)
  while (S.seq && S.seq.at < nodes.length) {
    const node = nodes[S.seq.at]
    out.push(...seqEmit(S, node, node.text))
    if (node.choices) { S.seq.awaiting = 'choice'; return out }
    if (node.ask) { S.seq.awaiting = 'ask'; return out }
    S.seq.at += 1
  }
  return [...out, ...endSequence(S)]
}

/** The scene is over; hand back to the game. */
export function endSequence (S) {
  if (!S.seq) return []
  S.seqSeen = [...new Set([...(S.seqSeen || []), S.seq.id])]
  S.seq = null
  S.expect = 'boot'
  return []
}

/**
 * The scene that /help plays. Named here rather than in copy because the
 * command is in code; copy-check confirms the scene exists and is replayable.
 */
export const HELP_SCENE = 'voice'

/**
 * A scene's lines, said again, without entering it.
 *
 * /help can be typed at any moment - mid-position, mid-scene, at the bell - so
 * this touches nothing the game runs on: no S.seq, no seqSeen, no expect. It
 * reads the nodes and renders them, which is exactly why the scene it names
 * must not stop to ask anything. A choice here would leave the player holding
 * a question with nothing listening for the answer, so copy-check refuses one.
 */
export function narrate (S, id) {
  return (section(`sequences.${id}`) || []).flatMap((node) => seqEmit(S, node, node.text))
}

/** The choices a sequence is waiting on, or none. */
export function sequenceChoices (S) {
  if (!S.seq || S.seq.awaiting !== 'choice') return []
  const node = seqNodes(S)[S.seq.at] || {}
  return Object.entries(node.choices || {})
    .map(([token, c]) => ({ token, label: render(c.label, seqCtx(S)) }))
}

/**
 * Feed the player's message to a running sequence.
 *
 * Returns emissions, or null when the message is not for the sequence - which
 * only happens for a choice it does not recognise, so the caller can say so
 * rather than silently swallowing it.
 */
export function answerSequence (S, cmd) {
  if (!S.seq) return null
  const node = seqNodes(S)[S.seq.at] || {}

  if (S.seq.awaiting === 'ask') {
    // whatever they typed, verbatim - this is a name, not a command
    S.vars[node.ask] = String(cmd || '').trim().slice(0, 60)
    applyBeat(S, node)
    S.seq.at += 1
    S.seq.awaiting = null
    return runSequence(S)
  }

  const choice = (node.choices || {})[String(cmd || '').trim().toLowerCase()]
  if (!choice) return null
  applyBeat(S, choice)
  S.seq.at += 1
  S.seq.awaiting = null
  const reply = seqEmit(S, { speaker: choice.speaker, art: choice.art }, choice.reply)
  return [...reply, ...runSequence(S)]
}

// ---------------------------------------------------------------------------
// Beats
//
// A setpiece belongs to a day of the probation week and fires once, ever, when
// that day begins. A beat may arrive mid-round: it does not interrupt a
// position, and a pending choice can be answered whenever - which is why an
// answer is checked before the ordinary dispatch and leaves `expect` alone.
//
// Choices colour the reply and nothing else, so there is no flag namespace and
// no branching to keep track of. What a choice may do is carry a small effect,
// and the same two are all a beat itself may carry.
// ---------------------------------------------------------------------------

/** Which day of the current week this is, 1-based. */
export const weekDay = (S) => (S.week?.length ?? 0) + 1

/**
 * The beat due right now, or null. A setpiece if this day of probation has one
 * and the player has not seen it; otherwise, on a repeat attempt, one of the
 * `again` lines - a second week would be silent without them, because a
 * setpiece fires once ever and not once per attempt.
 */
export function beatDue (S) {
  if (!S.probation) return null
  const schedule = section('beats.schedule') || {}
  const id = schedule[String(weekDay(S))]
  if (id && !(S.beatsSeen || []).includes(id)) return { id, kind: 'setpiece' }
  if ((S.attempts || 1) > 1) return { id: null, kind: 'again' }
  return null
}

/** Apply a beat's or a choice's effects. Only two things a beat may touch. */
function applyBeat (S, spec) {
  if (!spec || typeof spec !== 'object') return
  if (typeof spec.coherence === 'number') {
    S.coherence = clamp(S.coherence + spec.coherence, 0, 1)
  }
  if (spec.unlock) {
    S.unlocked = [...new Set([...(S.unlocked || []), spec.unlock])]
  }
}

/**
 * Fire the due beat, if any. A setpiece with choices leaves itself pending on
 * the session so the reply can be matched later; one without is simply said.
 */
export function fireBeat (S) {
  const due = beatDue(S)
  if (!due) return []
  if (due.kind === 'again') return [text(t('beats.again'))]

  const spec = section(`beats.${due.id}`)
  S.beatsSeen = [...(S.beatsSeen || []), due.id]
  // a beat is either a bare template or an object with text, choices, effects
  applyBeat(S, spec)
  const out = [text(t(typeof spec === 'string' ? `beats.${due.id}` : `beats.${due.id}.text`, {
    day: weekDay(S), budget: money(S.budget), attempt: S.attempts || 1,
  }))]
  if (spec && spec.choices) S.beat = due.id
  return out
}

/** The choices a pending beat is waiting on, as {token, label} - or none. */
export function beatChoices (S) {
  if (!S.beat) return []
  const spec = section(`beats.${S.beat}.choices`)
  return Object.entries(spec || {}).map(([token, c]) => ({ token, label: c.label }))
}

/**
 * Answer a pending beat. Returns emissions, or null if `cmd` is not one of its
 * choices - in which case the caller carries on as though no beat were pending,
 * so a beat never swallows a game command.
 */
export function answerBeat (S, cmd) {
  if (!S.beat) return null
  const spec = section(`beats.${S.beat}.choices`)
  const choice = spec && spec[String(cmd).trim().toLowerCase()]
  if (!choice) return null
  const id = S.beat
  S.beat = null
  applyBeat(S, choice)
  return [text(t(`beats.${id}.choices.${String(cmd).trim().toLowerCase()}.reply`, {
    coherence: S.coherence.toFixed(3),
  }))]
}

/**
 * Close every day that has elapsed, not just the one.
 *
 * A day used to close only when the player said something, so three days away
 * cost one day's ladder rather than three - time only passed while you watched.
 * Now the clock is the clock: an absence is three idle days and compounds like
 * three idle days. The cap is a guard against a session that has sat untouched
 * for a game month returning a hundred day-end messages at once; past it the
 * clock is simply reset to now and the days are forfeit.
 */
export function catchUpDays (S, nowMs = Date.now(), cap = 7) {
  const out = []
  let closed = 0
  while (dayIsOver(S, nowMs) && closed < cap) {
    // closeDay stamps dayStartedMs to now, which would swallow the remainder of
    // a long absence; wind it to the boundary that actually passed instead
    const boundary = S.dayStartedMs + realMs(GAME_DAY_SECONDS)
    out.push(...endOfDay(S))
    S.dayStartedMs = boundary
    closed += 1
  }
  if (dayIsOver(S, nowMs)) S.dayStartedMs = nowMs   // too far behind to replay
  return { emissions: out, closed }
}

/**
 * When this session next needs attention, in real milliseconds - whichever of
 * its clocks comes first. One timer per chat, so it has to be the soonest of
 * them, and whatever fires re-derives the next.
 */
export function nextWake (S, nowMs = Date.now()) {
  const due = [realMs(dayRemaining(S, nowMs))]
  if (S.expect === 'running' && S.run) due.push(msUntilNextPost(nowMs))
  // never busier than once a second, and never further off than an hour, so a
  // clock change or a long sleep cannot strand a session
  return Math.max(1000, Math.min(3600000, ...due))
}

/**
 * Which scene a verdict plays.
 *
 * Passing happens once - it takes the desk off probation for good - so there is
 * one scene for it. Failing can happen over and over, so the written scene
 * plays on the first failure and a shorter one after that; if the short one has
 * not been written yet the full one plays again, which is worse than a variant
 * and much better than silence.
 */
function verdictScene (r) {
  if (r.verdict === 'passed') return 'probation_passed'
  const again = 'probation_failed_again'
  const written = (id) => ((section(`sequences.${id}`) || []).length > 0)
  return r.failures > 1 && written(again) ? again : 'probation_failed'
}

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
  // The day that has just begun may have a setpiece. It goes out after the
  // accounting, because the accounting is what ended the day before it.
  const beat = fireBeat(S)

  if (r.weekTotal !== null) {
    const ctx = {
      total: `${r.weekTotal >= 0 ? '+' : ''}${money(r.weekTotal)}`,
      total_raw: r.weekTotal,
      paid: r.bonusPaid > 0,
      bonus: money(r.bonusPaid),
      pot: money(S.bonus),
      attempt: r.attempt,
      failures: r.failures,
      again: r.attempt > 1,
      budget: money(START_BUDGET),
      coherence: S.coherence.toFixed(3),
    }
    if (r.verdict) {
      // On probation the week is a verdict rather than an accounting, and a
      // verdict is a scene: people say things about it, and the player answers.
      // It takes the floor the way the opening does - the new week's worlds are
      // offered by the boot that follows the scene, not underneath it.
      out.push(...startSequence(S, verdictScene(r), ctx))
      if (inSequence(S)) S.expect = 'sequence'
    } else {
      // Off probation a week is an accounting: "no bonus this week" is a fact
      // about money, not something anyone comes over to tell you.
      out.push(text(t('scenes.week_end', ctx)))
    }
  }
  return [...out, ...beat]
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
  // A verdict scene has the floor. The round it hands back to is offered by
  // the boot that follows the scene ending - offering it here would print next
  // week's worlds underneath a conversation that has not finished happening.
  if (inSequence(S)) return []
  const rnd = mulberry(S.seed + S.rounds * 7919)
  return [...sceneMain(S), ...offerWorlds(S, rnd)]
}


