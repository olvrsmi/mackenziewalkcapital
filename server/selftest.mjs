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
  ok('a profitable day raises the budget 10%', day(120, true) === 1100, `got ${day(120, true)}`)
  ok('a losing day lowers it 5%', day(-300, true) === 950, `got ${day(-300, true)}`)
  ok('breaking even with a trade counts as profit', day(0, true) === 1100, `got ${day(0, true)}`)
  ok('a day with no investment counts as a loss', day(0, false) === 950, `got ${day(0, false)}`)
  ok('the budget floors at 500', day(-100, true, 500) === 500, `got ${day(-100, true, 500)}`)
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
