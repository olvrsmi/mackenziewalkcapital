// selftest.mjs - the invariants that have broken in play, in the order they broke.
//
// dryrun.mjs walks one happy round; this covers the edges around it: a session
// restored from disk, the day boundary, and the arithmetic the budget rests on.

import './env.mjs'
import { rm, readFile } from 'node:fs/promises'
import { loadCopy } from './copy.mjs'

const SCRATCH = new URL('./.selftest-state/', import.meta.url).pathname
process.env.MW_STATE_DIR = SCRATCH

loadCopy({ quiet: true })
const game = await import('./game.mjs')
const store = await import('./sessions.mjs')
const { realMs, GAME_DAY_SECONDS } = await import('./time.mjs')

let failures = 0
const ok = (name, cond, detail = '') => {
  if (cond) return console.log(`  pass  ${name}`)
  failures += 1
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
}

// --- a session restored from disk can finish its run -------------------------
//
// The world list is not saved, and a session that was mid-run when the process
// stopped is resumed by the timer rather than by boot. The run then stepped
// along fine until it ended and tried to offer three new worlds from nothing.
{
  const chatId = 'restore'
  const S = game.newSession(11)
  await game.boot(S)
  await game.handle(S, '1'); await game.handle(S, 'i')
  await game.handle(S, '250'); await game.handle(S, '1'); await game.handle(S, '5')
  await store.save(chatId, S)
  store.forget(chatId)                       // as if the process had stopped

  const R = await store.load(chatId)
  ok('restored session has no world list', R.allWorlds === undefined)

  R.run.startedMs -= realMs(20 * game.READOUT_GAME_SECONDS)   // drive it to its exit
  let threw = null
  try { game.step(R) } catch (e) { threw = e }
  ok('an unhydrated run fails loudly, not on an undefined read',
     threw !== null && /hydrate/.test(threw.message),
     threw ? threw.message : 'it did not throw at all')

  const F = await store.load(chatId)         // fresh, unmutated by the throw above
  store.forget(chatId)
  const G = await store.load(chatId)
  await game.hydrate(G)
  G.run.startedMs -= realMs(20 * game.READOUT_GAME_SECONDS)
  const done = game.step(G)
  ok('a hydrated restored run settles and offers the next round',
     done.done === true && G.expect === 'world' && G.run === null,
     `done=${done.done} expect=${G.expect}`)
  void F
}

// --- the timer path still hydrates -------------------------------------------
//
// The guard above makes the failure loud, but the bug was a missing call in
// bot.mjs, and its timer path cannot be driven without Telegram. Checking the
// source is a proxy, but it is the call site that actually broke.
{
  const src = await readFile(new URL('./bot.mjs', import.meta.url), 'utf8')
  const step = src.slice(src.indexOf("sched.kind === 'step'"))
  ok('the timer path hydrates before stepping',
     /hydrate\(S\)/.test(step.slice(0, step.indexOf('game.step(S)'))))
}

// --- the budget arithmetic ---------------------------------------------------
{
  const day = (pl, traded, budget = 1000) => {
    const S = game.newSession(1)
    S.budget = budget; S.balance = budget + pl
    S.investedToday = traded ? 1 : 0; S.week = []; S.history = []
    return game.closeDay(S).next
  }
  // Breaking even used to count as a good day. It no longer does: inverted, 83%
  // of days finish up, and the ladder needs roughly a third of them to fail or
  // budgets compound without limit. The house wants QUOTA of the budget.
  const q = Math.round(1000 * game.QUOTA)
  ok('clearing the quota raises the budget 10%', day(q, true) === 1100, `got ${day(q, true)}`)
  ok('a losing day lowers it 5%', day(-300, true) === 950, `got ${day(-300, true)}`)
  ok('breaking even no longer counts - the quota is not cleared',
     day(0, true) === 950, `got ${day(0, true)}`)
  ok('nor does a profit short of the quota',
     day(q - 1, true) === 950, `got ${day(q - 1, true)}`)
  ok('a day with no investment counts as a loss', day(0, false) === 950, `got ${day(0, false)}`)
  ok('the budget floors at 500', day(-100, true, 500) === 500, `got ${day(-100, true, 500)}`)
  ok('the quota scales with the budget',
     day(Math.round(2000 * game.QUOTA), true, 2000) === 2200,
     `got ${day(Math.round(2000 * game.QUOTA), true, 2000)}`)
}

// --- stakes and returns stay whole -------------------------------------------
//
// A 250G stake returning 249.975 displayed as a flat day but settled a hair
// under budget, and billed the -5% meant for a loss.
{
  const S = game.newSession(3)
  await game.boot(S)
  await game.handle(S, '1'); await game.handle(S, 'i')
  await game.handle(S, '250.7')
  ok('a fractional stake is rounded to whole G',
     Number.isInteger(S.pending.stake), `stake=${S.pending?.stake}`)
  await game.handle(S, '1'); await game.handle(S, '4')
  S.run.startedMs -= realMs(20 * game.READOUT_GAME_SECONDS)
  game.step(S)
  ok('the balance stays a whole number after settling',
     Number.isInteger(S.balance), `balance=${S.balance}`)
}

// --- posting follows the scale, and never repeats itself --------------------
{
  ok('posting is derived from game time, not pinned to real time',
     game.POST_MS === Math.round(realMs(game.POST_GAME_SECONDS)) ||
     process.env.MW_POST_MS != null,
     `POST_MS=${game.POST_MS} POST_GAME_SECONDS=${game.POST_GAME_SECONDS}`)

  const S = game.newSession(31)
  await game.boot(S)
  await game.handle(S, '1'); await game.handle(S, 'i')
  await game.handle(S, '250'); await game.handle(S, '1'); await game.handle(S, '6')

  // a post landing early in the first interval has nothing new to say
  const early = game.step(S, S.run.startedMs + realMs(game.READOUT_GAME_SECONDS) / 3)
  ok('a post before the first readout stays quiet rather than repeating the entry',
     early.emissions.length === 0, `${early.emissions.length} emission(s)`)

  // and each post after that carries exactly one reading. A reading rides as
  // the caption on its own graph now, so counting text emissions would miss it.
  const readings = (em) => em.flatMap((e) =>
    (e.caption ?? (e.kind === 'text' ? e.text : '')).split('\n').filter(Boolean)).length
  const counts = []
  let t = S.run.startedMs + realMs(game.READOUT_GAME_SECONDS) / 3
  for (let i = 0; i < 4; i++) {
    t += game.POST_MS
    counts.push(readings(game.step(S, t).emissions))
  }
  ok('one reading per post once the circuit is moving',
     counts.every((c) => c === 1), `counts: ${counts.join(', ')}`)
}

// --- a reading and its graph are one message -------------------------------
{
  const S = game.newSession(41)
  await game.boot(S)
  await game.handle(S, '1'); await game.handle(S, 'i')
  await game.handle(S, '250'); await game.handle(S, '1'); await game.handle(S, '6')
  S.run.startedMs -= realMs(2 * game.READOUT_GAME_SECONDS)
  const em = game.step(S).emissions
  const withCaption = em.filter((e) => e.kind === 'traces' && e.caption)
  ok('the reading rides on its own graph, not a message of its own',
     withCaption.length === 1 && !em.some((e) => e.kind === 'text'),
     em.map((e) => e.kind).join(', '))
}

// --- holdings are named per world ------------------------------------------
{
  const S = game.newSession(43)
  await game.boot(S)
  const all = S.worlds.flatMap((w) => w.holdings)
  ok('every world names its holdings',
     S.worlds.every((w) => w.holdings.length === w.info.n),
     S.worlds.map((w) => `${w.info.n}:${w.holdings.length}`).join(' '))
  ok('no ticker means two things in one offer',
     new Set(all).size === all.length, all.join(' '))
  await game.handle(S, '1')
  ok('the plots are labelled with them',
     game.sceneInvestment(S).some((e) => e.holdings?.length === S.world.info.n))
}

// --- the sheet --------------------------------------------------------------
{
  const info = { id: 'spec_sheet_01', n: 4, book: [0, 3, 6, 12],
                 pairs: [[0, 1], [1, 2], [2, 3]], max_pairs: 6 }
  const T = ['AAA', 'BBB', 'CCC', 'DDD']
  const sheet = game.overview(info, T)

  ok('one row per holding', sheet.length === 4)
  ok('every row carries a price', sheet.every((h) => /^[\d,]+G$/.test(h.price)))
  ok('a heavier book reads as more contracted',
     sheet[0].contracted !== sheet[3].contracted,
     `${sheet[0].contracted} vs ${sheet[3].contracted}`)
  ok('exposure names the holdings it is wired to, not indices',
     sheet[1].exposure === 'AAA, CCC', sheet[1].exposure)
  ok('a holding wired to nothing says so',
     game.overview({ ...info, pairs: [] }, T).every((h) => !h.exposed))

  // the whole point: the sheet must not answer the question it is asked around
  const keys = Object.keys(sheet[0]).join(' ')
  ok('the sheet carries no measure of how far a holding will move',
     !/range|volatil|inert/i.test(keys), keys)

  // The sheet tests above use synthetic book arrays, which is why none of them
  // could catch the letter-to-qubit mapping being mirrored. QDrive follows
  // qiskit: the RIGHTMOST letter is qubits[0]. Asymmetric words are the only
  // ones that expose it - 'XX' looks identical either way round.
  ok('an asymmetric Pauli word contracts the holding qiskit says it does',
     (() => {
       const spec = { n: 2, targets: [{ expvals: { XI: 1 }, qubits: [0, 1] }] }
       const b = [0, 1].map((q) => spec.targets.reduce((a, t) => {
         if (!t.qubits.includes(q)) return a
         return a + Object.keys(t.expvals).filter(
           (w) => w[w.length - 1 - t.qubits.indexOf(q)] !== 'I').length
       }, 0))
       return b[0] === 0 && b[1] === 1     // 'XI' -> X on qubits[1], I on qubits[0]
     })(),
     "'XI' must contract qubits[1], not qubits[0]")

  // banded absolutely, so a light world reads as light rather than as whatever
  // happens to be heaviest inside it
  const light = game.overview({ id: 'x', n: 2, book: [3, 3], pairs: [[0, 1]], max_pairs: 1 },
                              ['AAA', 'BBB'])
  ok('a light world does not read as heavily contracted',
     light[0].contracted === sheet[1].contracted, light[0].contracted)
}

// --- pricing --------------------------------------------------------------
{
  const info = { id: 'spec_test_01', n: 4, book: [1, 4, 4, 9] }
  const bases = [0, 1, 2, 3].map((q) => game.basePrice(info, q))

  ok('a bigger book lists dearer', bases[3] > bases[0],
     bases.map((b) => b.toFixed(0)).join(' '))
  ok('no two holdings list at the same price', new Set(bases).size === 4,
     'the float is what separates holdings whose books tie')
  ok('the float is stable', game.basePrice(info, 2) === bases[2])

  // inverted: a world opens polarised at <Z> ~ +1 and recovers toward 0
  ok('a falling reading is a rising quote',
     game.quote(bases[0], -1) > game.quote(bases[0], 1))
  ok('a quote is positive for any reading',
     [-1, -0.5, 0, 0.5, 1].every((z) => game.quote(bases[1], z) > 0))

  // the base cancels, so price cannot be used to pick a winner
  const cheap = game.priceReturn(0.5, -0.5)
  ok('the same move pays the same on a cheap holding and a dear one',
     Math.abs(cheap - game.priceReturn(0.5, -0.5)) < 1e-12)
  ok('holding through a recovery profits', game.priceReturn(1, -1) > 0)
  ok('holding through a decline loses', game.priceReturn(-1, 1) < 0)
}

// --- the bell ----------------------------------------------------------------
{
  const S = game.newSession(5)
  await game.boot(S)
  await game.handle(S, '1'); await game.handle(S, 'i')
  await game.handle(S, '250'); await game.handle(S, '1')
  S.dayStartedMs = Date.now() - realMs(GAME_DAY_SECONDS - 2.5 * game.READOUT_GAME_SECONDS)
  const warn = await game.handle(S, '6')
  ok('an exit past the bell is queried first',
     S.expect === 'confirm_exit' && warn.emissions.some((e) => /bell/i.test(e.text || '')))
  await game.handle(S, 'y')
  S.run.startedMs -= realMs(2 * game.READOUT_GAME_SECONDS)
  S.dayStartedMs = Date.now() - realMs(GAME_DAY_SECONDS + 1)
  const out = game.step(S).emissions.filter((e) => e.kind === 'text').map((e) => e.text)
  const bell = out.findIndex((x) => /closes/.test(x))
  const round = out.findIndex((x) => /^\*\*Round/m.test(x))
  ok('the day closes before the next round is offered',
     bell >= 0 && round >= 0 && bell < round, `bell at ${bell}, round at ${round}`)
  ok('the new round reads the new budget',
     out[round]?.includes(S.budget.toLocaleString('en-GB')), out[round]?.split('\n')[2])
}

await rm(SCRATCH, { recursive: true, force: true })
console.log(failures ? `\n  ${failures} failed\n` : '\n  all good\n')
process.exit(failures ? 1 : 0)
