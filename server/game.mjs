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
import { gameSeconds, describeGame, describeReal, GAME_DAY_SECONDS } from './time.mjs'

export const READOUTS = 8

// Two clocks, deliberately separate. Readouts come due on a GAME-time schedule,
// so retuning MW_TIME_SCALE retunes the physics with it. Messages go out on a
// REAL clock boundary, so everyone's news lands at the same moment. One post can
// therefore cover several readouts, or none.
export const READOUT_GAME_SECONDS =
  Number(process.env.MW_READOUT_GAME_SECONDS || 3600)   // a game hour apiece
export const POST_MS = Number(process.env.MW_POST_MS || 3600000)  // real, aligned
export const STEP_MS = POST_MS                          // kept for the scheduler
export const START_MONEY = 1000

// The economy runs in GAME seconds; time.mjs decides how fast those pass.
// Free regeneration restores a spent qubit over about eight game hours, and a
// purchased unit adds a quarter of that rate for 1G per game day.
export const FULL_RECHARGE_GAME_SECONDS =
  Number(process.env.MW_RECHARGE_GAME_SECONDS || 8 * 3600)
export const BASE_REGEN = 1 / FULL_RECHARGE_GAME_SECONDS   // per game second
export const REGEN_UNIT = BASE_REGEN * 0.25                // per game second
export const UNIT_COST_PER_DAY = 1                         // G per game day
export const DAY_SECONDS = GAME_DAY_SECONDS                // game seconds

const WORLD_NAMES = [
  'Powder Pram', 'Rice Vision', 'Tables Expert', 'Tidy Memo',
  'Less Locker', 'Bats Dawn', 'Skinny Reds', 'Sadly Trial',
  'Cooks Vrush', 'Shut Cube', 'Candle Master', 'Pile Fixed',
  'Radio Farms', 'Engine Ocean', 'Curiosity Metro', 'Tiger Eaten',
  'Closed Shots', 'Closed Hits', 'Lonely Jumps', 'Open Online',
  'Fine Class', 'Normal Dark', 'Caller Lions', 'Chin Lend',
  'Every Couches', 'Liked Rounds', 'Third Hooks', 'Think Goes',
  'Spare Enjoyable', 'Bland Chase', 'Salsa Shade', 'Wanted Gravy',
  'Social Note', 'Audio Grace', 'Limbs Send',
]

const CHATTER = [
  'The circuit is mid-run. Nothing to decide until it settles.',
  'Noted. The gates do not care.',
  'Still running. You can only watch from here.',
  'The stake is placed. It plays out either way.',
]

const money = (v) => `${Math.round(v).toLocaleString('en-GB')}G`

const COMPLEXITY = [[25, 'simple'], [60, 'moderate'], [150, 'involved'],
                    [500, 'dense'], [Infinity, 'labyrinthine']]

/** The technical facts of a circuit, said as a market would say them. */
export function prospectus (info) {
  const complexity = COMPLEXITY.find(([lim]) => info.gates < lim)[1]
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
    money: START_MONEY,
    history: [START_MONEY],
    rounds: 0,
    regenUnits: 0,
    clockMs: Date.now(),
    billed: 0,
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

export function dailyCost (S) {
  return S.regenUnits * UNIT_COST_PER_DAY
}

// ---------------------------------------------------------------------------
// The clock: coherence returns, the subscription bills. Both accrue against
// real elapsed seconds, so time spent reading, waiting or running all counts.
// ---------------------------------------------------------------------------

export function tick (S, nowMs = Date.now()) {
  const elapsed = gameSeconds(Math.max(0, nowMs - S.clockMs))   // game seconds
  S.clockMs = nowMs

  const before = S.coherence
  S.coherence = Math.min(1, S.coherence + regenRate(S) * elapsed)
  const gained = S.coherence - before

  let cost = dailyCost(S) * (elapsed / DAY_SECONDS)
  cost = Math.min(cost, S.money)          // never bills into debt
  S.money -= cost
  S.billed += cost

  let lapsed = false
  if (S.regenUnits > 0 && S.money < dailyCost(S) * 0.05) {
    S.regenUnits = 0                      // cannot cover the next charge
    lapsed = true
  }
  return { elapsed, gained, cost, lapsed }
}

function tickLines (t) {
  const bits = []
  if (t.gained > 0.0005) bits.push(`coherence +${t.gained.toFixed(3)}`)
  if (t.cost > 0.5) bits.push(`subscription -${money(t.cost)}`)
  const out = []
  if (bits.length) out.push(`${describeGame(t.elapsed)} passed: ${bits.join(', ')}`)
  if (t.lapsed) out.push('You could not cover the subscription. The plan has lapsed.')
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
    money: Math.round(S.money),
    regenRate: +rate.toFixed(4),
    regenUnits: S.regenUnits,
    dailyCost: dailyCost(S),
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
    cuts: S.clean.cuts,
    z: (opts.z || S.clean.z).slice(0, upto + 1),
    upto,
    totalReadouts: S.world.readouts,
    target: opts.target ?? null,
    interventionAt: opts.interventionAt ?? null,
    title: opts.title || `${S.world.name} — <Z> to readout ${upto}`,
  }
}

function gatemapPanel (S) {
  return {
    kind: 'gatemap',
    n: S.world.info.n,
    layers: S.clean.layers,
    cuts: S.clean.cuts,
    nLayers: S.clean.n_layers,
    pairs: S.world.info.pairs,
    title: `${S.world.name} — ${S.world.info.gates} gates over ` +
           `${S.clean.n_layers} layers`,
  }
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

export function sceneMain (S) {
  const recovery = S.coherence < 0.999
    ? ` (recovery in ${describeReal((1 - S.coherence) / regenRate(S))})`
    : ''
  return [text(
    `**Round ${S.rounds + 1}**\n\n` +
    `Your coherence: ${S.coherence.toFixed(3)}${recovery}\n` +
    `Your balance: ${money(S.money)}` +
    (S.regenUnits
      ? `\nSubscription: ${money(dailyCost(S))} a game day` : ''))]
}

export function offerWorlds (S, rnd) {
  const pool = S.allWorlds
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
    const n = WORLD_NAMES[Math.floor(rnd() * WORLD_NAMES.length)]
    if (!names.includes(n)) names.push(n)
  }
  S.worlds = picks.map((info, i) => ({
    info, name: names[i], readouts: info.readouts,
  }))
  S.expect = 'world'
  return [text('Three worlds are open to you.')]
}

export function sceneInvestment (S) {
  const k = S.readoutIndex
  S.expect = 'invest'
  const out = []
  if (k === 0) out.push(gatemapPanel(S))
  out.push(tracesPanel(S, k))
  out.push(text(
    `**${S.world.name}** — progress ${k}/${S.world.readouts - 1}\n\n` +
    `Your coherence: ${S.coherence.toFixed(3)}\n` +
    `Your balance: ${money(S.money)}` +
    (k === S.world.readouts - 2
      ? '\n\n_Last chance to act._' : '')))
  return out
}

export function sceneMarket (S) {
  S.expect = 'market'
  const runway = dailyCost(S) > 0 ? S.money / dailyCost(S) : null
  return [text(
    `**The marketplace**\n` +
    `A spent qubit comes back on its own in ` +
    `${describeReal(1 / BASE_REGEN)}. Units make that faster: each one adds a ` +
    `quarter again for ${UNIT_COST_PER_DAY}G a game day, billed continuously.` +
    `\n\nCoherence ${S.coherence.toFixed(3)} · balance ${money(S.money)}\n` +
    `Units subscribed ${S.regenUnits} · ${money(dailyCost(S))} a game day` +
    (S.coherence < 0.999
      ? `\nFull again in ${describeReal((1 - S.coherence) / regenRate(S))}` +
        (S.regenUnits ? '' : ` — ${describeReal(FULL_RECHARGE_GAME_SECONDS *
          (1 - S.coherence) / (1 + 0.25 * 10))} with ten units`)
      : '\nYour qubit is whole.') +
    (runway !== null ? `\nRunway ${runway.toFixed(1)} game days` : '') +
    '\n\nType **b** to buy · **s** to sell · **l** to leave')]
}


// ---------------------------------------------------------------------------
// The command handler. Short tokens for now; `expect` gives each its meaning.
//
// Returns {emissions, schedule} where schedule, if present, asks the server to
// come back later: {kind:'step'|'hold', ms}. The server owns all timers so the
// rules stay free of them.
// ---------------------------------------------------------------------------

export async function boot (S) {
  if (!S.allWorlds) {
    const w = await callModel({ op: 'worlds', readouts: READOUTS })
    S.allWorlds = w.worlds
    S.skipped = w.skipped.length
  }
  const rnd = mulberry(S.seed + S.rounds * 7919)
  return {
    emissions: [
      text('**OFFICE 4B, 6 MACKENZIE WALK**\n\n' +
        'You carry one qubit. Each world is a quantum circuit you may enter. ' +
        'Pick a moment, couple your qubit to one of theirs, and stake on it. ' +
        'You are paid the change in that qubit\'s Z, halved, times your stake.\n\n' +
        'Your qubit keeps whatever the circuit does to it. You keep exactly as ' +
        'much coherence as the qubit you couple to had itself — couple to ' +
        'something the circuit has already scrambled and yours is scrambled too. ' +
        `It returns at ${BASE_REGEN.toFixed(3)}/s on its own; the marketplace ` +
        'sells more.\n\n' +
        `_${S.allWorlds.length} worlds available (${S.skipped} circuits ` +
        'unusable — mid-circuit measurement, unparseable QASM, or out of range)._'),
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
  const t = tick(S)
  const pre = tickLines(t).map(text)
  let preSent = false
  const out = (...e) => ({ emissions: [...(preSent ? [] : pre), ...e.flat()] })
  const cmd = String(raw || '').trim().toLowerCase()

  if (!cmd) return out(text('Say something, or type **help**.'))
  if (cmd === 'help' || cmd === '?') {
    return out(text(
      '**Commands**\n' +
      '`1` `2` `3` — enter a world · `m` — marketplace · `t` — wait\n' +
      '`i` — invest · `w` — watch on to the next readout\n' +
      '`b` / `s` — buy or sell regeneration units · `l` — leave the marketplace\n' +
      'When asked for a number, just type it.'))
  }
  if (cmd === 'state' || cmd === 'status') return out(sceneMain(S))

  switch (S.expect) {
    case 'running':
    case 'holding':
      return out(text(CHATTER[Math.floor(Math.random() * CHATTER.length)]))

    case 'world': {
      if (cmd === 'm') return out(sceneMarket(S))
      const i = num(cmd)
      if (![1, 2, 3].includes(i)) {
        return out(text('Type **1**, **2** or **3**, or **m**, or **t**.'))
      }
      S.world = S.worlds[i - 1]
      S.expect = 'scouting'
      // acknowledge the tap before going to the model, not after
      const pr = prospectus(S.world.info)
      const entered = text(
        `**${S.world.name}**\n` +
        `${pr.opportunities} investment opportunit` +
        `${pr.opportunities === 1 ? 'y' : 'ies'} · ${pr.complexity}\n` +
        `${pr.monopoly}% corporate monopolisation\n` +
        `${pr.volatility}% expected volatility` +
        (S.world.info.connected ? '' : '\n_Holdings here do not all connect._'))
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
        return out(text('You leave before anything is committed.'),
                   sceneMain(S), offerWorlds(S, rnd))
      }
      if (cmd === 'o' || cmd === 'w') {
        S.readoutIndex += 1
        if (S.readoutIndex > S.world.readouts - 2) {
          return out(text('You observed the whole circuit and staked nothing. ' +
                          'Your qubit is untouched.'), ...endRound(S))
        }
        return out(sceneInvestment(S))
      }
      if (cmd !== 'i') {
        return out(text('Type **i** to invest · **o** to observe' +
          (S.readoutIndex === 0 ? ' · **l** to leave' : '')))
      }
      if (S.money < 1) return out(text('You have nothing left to stake.'))
      S.expect = 'stake'
      return out(text(`How much do you stake? (1 – ${Math.floor(S.money)})`))
    }

    case 'stake': {
      const v = num(cmd)
      if (v === null || v < 1) {
        S.expect = 'invest'
        return out(text('Not a stake. Type **i** to try again or **w** to watch.'))
      }
      S.pending = { stake: clamp(v, 1, S.money) }
      S.expect = 'target'
      return out(text(`Couple to which qubit? (0 – ${S.world.info.n - 1})`))
    }

    case 'target': {
      const q = num(cmd)
      if (q === null || q < 0 || q >= S.world.info.n || !Number.isInteger(q)) {
        return out(text(`Pick a qubit from 0 to ${S.world.info.n - 1}.`))
      }
      S.pending.target = q
      S.expect = 'exit'
      const last = S.world.readouts - 1
      return out(text(
        `Coupling to **q${q}**. Where do you take profit?\n\n` +
        `You are at readout ${S.readoutIndex}. Choose any readout from ` +
        `${S.readoutIndex + 1} to ${last} — the position closes there and the ` +
        `round ends. Later is more time for the qubit to move, in either ` +
        `direction.`))
    }

    case 'exit': {
      const exitAt = num(cmd)
      const last = S.world.readouts - 1
      if (exitAt === null || !Number.isInteger(exitAt) ||
          exitAt <= S.readoutIndex || exitAt > last) {
        return out(text(`Pick a readout from ${S.readoutIndex + 1} to ${last}.`))
      }
      const q = S.pending.target
      const stake = S.pending.stake
      S.pending = null
      S.money -= stake
      if (emit) {
        preSent = true
        await emit([...pre, text(`Staking ${money(stake)} on **q${q}**. ` +
          'Coupling now…')])
      }
      const play = await callModel({
        op: 'play', circuit: S.world.info.id, readouts: READOUTS,
        invest_at: S.readoutIndex, target: q,
        direction: S.direction, coherence: S.coherence,
      })
      S.run = { investAt: S.readoutIndex, target: q, stake, exitAt, ...play,
                revealed: S.readoutIndex, startedMs: Date.now() }
      S.expect = 'running'
      return {
        emissions: [...(preSent ? [] : pre),
          ...(preSent ? [] : [text(`Staking ${money(stake)} on **q${q}**. ` +
                                   'Coupling now.')]),
          text(`_Position open on **q${q}** until progress ${exitAt}. ` +
               `Reports every ${postEvery()}._`),
          stepPanel(S)],
        schedule: { kind: 'step', ms: msUntilNextPost() },
      }
    }

    case 'market': {
      if (cmd === 'l') { const rnd = mulberry(S.seed + S.rounds * 7919)
                         return out(sceneMain(S), offerWorlds(S, rnd)) }
      if (cmd === 'b') { S.expect = 'buy'; return out(text('How many units?')) }
      if (cmd === 's') {
        if (!S.regenUnits) return out(text('You have nothing to sell.'))
        S.expect = 'sell'
        return out(text(`How many units? (up to ${S.regenUnits})`))
      }
      return out(text('Type **b**, **s** or **l**.'))
    }

    case 'buy': {
      const k = num(cmd)
      if (k === null || k < 1) return out(sceneMarket(S))
      S.regenUnits += Math.floor(k)
      return out(text(`Subscribed. Your rate is now ` +
        `${regenRate(S).toFixed(4)}/s at ${money(dailyCost(S))}/day.`),
        sceneMarket(S))
    }

    case 'sell': {
      const k = num(cmd)
      if (k === null || k < 1) return out(sceneMarket(S))
      S.regenUnits = Math.max(0, S.regenUnits - Math.floor(k))
      return out(text(`Cancelled. Your rate is now ` +
        `${regenRate(S).toFixed(4)}/s at ${money(dailyCost(S))}/day.`),
        sceneMarket(S))
    }

    case 'wait': {
      const secs = num(cmd)
      if (secs === null || secs <= 0) { S.expect = 'market'; return out(sceneMarket(S)) }
      const hold = clamp(secs, 1, 600)
      S.expect = 'holding'
      S.holdUntil = Date.now() + hold * 1000
      return {
        emissions: [...pre, text(`Waiting ${Math.round(hold)}s. ` +
          `Coherence returns at ${regenRate(S).toFixed(4)}/s` +
          (S.regenUnits
            ? `, and the meter runs at ${money(dailyCost(S))}/day.` : '.'))],
        schedule: { kind: 'hold', ms: hold * 1000 },
      }
    }

    default:
      return out(text('Nothing to decide just now.'))
  }
}

function waitPrompt (S) {
  const rate = regenRate(S)
  if (S.coherence >= 0.999) {
    S.expect = 'market'
    return [text('Your qubit is already whole.'), ...sceneMarket(S)]
  }
  const need = Math.round((1 - S.coherence) / rate)
  return [text(`At ${rate.toFixed(4)}/s it is ${need}s to full` +
    (S.regenUnits
      ? `, costing ${money(dailyCost(S) * need / DAY_SECONDS)}.` : '.') +
    '\n\nWait how many seconds? (0 to think again)')]
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
    title: `${S.world.name} — q${r.target} running ` +
      `${(((r.z[k][r.target] - z0) / 2) * 100).toFixed(1)}%`,
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

  const due = dueIndex(S, now)
  const from = r.revealed + 1
  if (due < from) {
    // nothing has come due; say so rather than going silent
    return {
      emissions: [text(`**${S.world.name}** · q${r.target} @ ` +
        `${fmt(r.z[r.revealed][r.target])} · ` +
        `${pct((r.z[r.revealed][r.target] - r.z[r.investAt][r.target]) / 2)} →`)],
      schedule: { kind: 'step', ms: msUntilNextPost(now) },
      done: false,
    }
  }

  r.revealed = due
  const z0 = r.z[r.investAt][r.target]
  const rows = []
  for (let k = from; k <= due; k++) {
    const z = r.z[k][r.target]
    const prev = r.z[k - 1][r.target]
    const arrow = z > prev + 1e-6 ? '↗' : (z < prev - 1e-6 ? '↘' : '→')
    rows.push(`**${S.world.name}** · q${r.target} @ ${fmt(z)} · ` +
              `${pct((z - z0) / 2)} ${arrow}`)
  }
  const emissions = [text(rows.join('\n')), stepPanel(S)]

  if (due >= r.exitAt) return { emissions: [...emissions, ...settle(S)], done: true }
  return { emissions, schedule: { kind: 'step', ms: msUntilNextPost(now) },
           done: false }
}

const fmt = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`
const pct = (m) => `${m >= 0 ? '+' : ''}${(m * 100).toFixed(1)}%`

/** The returns scene, then back to the main scene. */
function settle (S) {
  const r = S.run
  const z0 = r.z[r.investAt][r.target]
  const z1 = r.z[r.exitAt][r.target]
  const dz = z1 - z0
  const mult = dz / 2
  // the stake was taken when the coupling was made; it comes back scaled by
  // (1 + multiplier), so a worst call loses it all and a best call doubles it
  const returned = r.stake * (1 + mult)
  const profit = returned - r.stake
  S.money = Math.max(0, S.money + returned)

  const before = S.coherence
  const fr = norm(r.apparatus)
  if (fr > 1e-9) S.direction = r.apparatus.map((x) => x / fr)
  S.coherence = clamp(fr, 0, 1)

  const out = [{ kind: 'text', text:
    `**Returns**\n` +
    `q${r.target} ⟨Z⟩ when you coupled  ${z0.toFixed(4)}\n` +
    `q${r.target} ⟨Z⟩ at readout ${r.exitAt}      ${z1.toFixed(4)}\n` +
    `Change                    ${dz >= 0 ? '+' : ''}${dz.toFixed(4)}\n` +
    `Multiplier (change / 2)   ${mult >= 0 ? '+' : ''}${mult.toFixed(4)}\n\n` +
    `Staked ${money(r.stake)} · returned ${money(returned)} · ` +
    `**${profit >= 0 ? 'profit' : 'loss'} ${profit >= 0 ? '+' : ''}` +
    `${money(profit)}**\n` +
    `Balance ${money(S.money)}` +
    (Math.abs(dz) < 1e-6 ? '\n\n_That qubit never moved. Some of them never do._' : '') +
    `\n\nYour qubit came back at coherence ${S.coherence.toFixed(3)} ` +
    `(was ${before.toFixed(3)})` +
    (S.coherence < before - 0.3
      ? `\n_q${r.target} was well scrambled by the time you reached it, and took ` +
        'your qubit with it._' : '') }]

  S.history.push(S.money)
  S.run = null
  return [...out, ...endRound(S)]
}

function endRound (S) {
  S.rounds += 1
  S.world = null
  S.clean = null
  S.readoutIndex = 0
  if (S.money < 1 && S.regenUnits === 0) {
    S.expect = 'over'
    return [{ kind: 'text', text: '**You are out of money. The walk ends here.**' }]
  }
  const rnd = mulberry(S.seed + S.rounds * 7919)
  return [...sceneMain(S), ...offerWorlds(S, rnd)]
}

/** A deliberate wait has elapsed. */
export function endHold (S) {
  const t = tick(S)
  const lines = tickLines(t).map(text)
  S.expect = 'market'
  return [...lines,
    text(`Coherence now ${S.coherence.toFixed(3)}.`),
    ...sceneMarket(S)]
}
