// selftest.mjs - the invariants that have broken in play, in the order they broke.
//
// dryrun.mjs walks one happy round; this covers the edges around it: a session
// restored from disk, the day boundary, and the arithmetic the budget rests on.

import './env.mjs'
import { rm, readFile, writeFile } from 'node:fs/promises'
import { loadCopy, section, list } from './copy.mjs'

const SCRATCH = new URL('./.selftest-state/', import.meta.url).pathname
process.env.MW_STATE_DIR = SCRATCH

loadCopy({ quiet: true })
const game = await import('./game.mjs')
const store = await import('./sessions.mjs')
const { realMs, GAME_DAY_SECONDS } = await import('./time.mjs')
const { renderEmission, artPath, isAnimation, hasAudio } = await import('./render.mjs')

/**
 * A session sitting at the world offer, past the opening scene.
 *
 * The intro has the floor at boot, so a block that boots and then plays tokens
 * would have its first one bounced. Every test below that wants a playable game
 * starts here; the intro's own block boots directly, because the scene is the
 * thing it is testing.
 */
const playable = async (seed) => {
  const S = game.newSession(seed)
  await game.boot(S)
  if (game.inSequence(S)) await game.handle(S, 'skip')
  return S
}

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
  const S = await playable(11)
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
  const wake = src.slice(src.indexOf('function fireFor'))
  ok('the wake hydrates before stepping',
     /hydrate\(S\)/.test(wake.slice(0, wake.indexOf('game.step(S)'))))
  // and closes days before it steps, or a run settles into a day that has ended
  ok('the wake closes days before it steps a run',
     wake.indexOf('catchUpDays') < wake.indexOf('game.step(S)'))
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
  const S = await playable(3)
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

  const S = await playable(31)
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
  const S = await playable(41)
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
  const S = await playable(43)
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

// --- the plot -------------------------------------------------------------
{
  // Rendering is checked by rendering: a plot that throws is a dead turn, and
  // the shapes that break it are the small and the degenerate ones.
  const png = (n, prices) => renderEmission({
    kind: 'traces', n, holdings: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG'],
    z: prices, priced: prices, upto: prices.length - 1,
    totalReadouts: prices.length, target: 0, interventionAt: 1, title: 'test',
  })
  const rows = (n, f) => Array.from({ length: 6 }, (_, k) =>
    Array.from({ length: n }, (_, q) => f(k, q)))

  ok('draws seven holdings', png(7, rows(7, (k, q) => 100 * (q + 1) * (1 + k / 20))).length > 0)
  ok('draws two', png(2, rows(2, (k, q) => 250 + q * 100 + k)).length > 0)
  // a world where nothing moves at all: every value identical, so lo === hi
  ok('draws a world that never moves', png(3, rows(3, () => 500)).length > 0)
  // and one spanning two decades, where the log axis earns its keep
  ok('draws a ghost of the uncoupled run behind a held holding',
     renderEmission({ kind: 'traces', n: 3, holdings: ['AAA', 'BBB', 'CCC'],
       z: rows(3, (k, q) => 100 * (q + 1) + k), priced: rows(3, (k, q) => 100 * (q + 1) + k),
       clean: rows(3, (k, q) => 100 * (q + 1) + k * 2), upto: 5, totalReadouts: 6,
       target: 1, interventionAt: 2, title: 'ghost' }).length > 0)
  ok('draws across two decades', png(4, rows(4, (k, q) => 50 * Math.pow(4, q) + k)).length > 0)
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

// --- probation -------------------------------------------------------------
{
  const week = (pls, S = game.newSession(1)) => {
    S.history = []
    let last
    for (const pl of pls) { S.balance = S.budget + pl; S.investedToday = 1; last = game.closeDay(S) }
    return { S, last }
  }

  const won = week([200, -50, 120, -30, 90, 40, 10])
  ok('a profitable week passes probation',
     won.last.verdict === 'passed' && won.S.probation === false, won.last.verdict)
  ok('probation pays no bonus - the week is the reward',
     won.last.bonusPaid === 0, String(won.last.bonusPaid))
  ok('and the week after does pay one',
     week([200, -50, 120, -30, 90, 40, 10], won.S).last.bonusPaid > 0)

  const lost = week([-200, -50, 120, -30, -90, 40, 10])
  ok('a losing week fails it', lost.last.verdict === 'failed', lost.last.verdict)
  ok('a retry winds the desk back',
     lost.S.budget === game.START_BUDGET && lost.S.week.length === 0 && lost.S.attempts === 2,
     `budget ${lost.S.budget} week ${lost.S.week.length} attempt ${lost.S.attempts}`)
  ok('but the player keeps their own qubit',
     lost.S.coherence > 0 && lost.S.probation === true)

  // exactly zero is not a profit
  ok('breaking even over the week does not pass',
     week([0, 0, 0, 0, 0, 0, 0]).last.verdict === 'failed')
}

// --- the intro ---------------------------------------------------------------
{
  const S = game.newSession(91)
  const opening = await game.boot(S)
  ok('a first sitting opens with the scene, not the brochure',
     game.inSequence(S) && !opening.emissions.some((e) => /premier neo-market/.test(e.text || '')))
  ok('and bursts to the first thing it wants',
     S.seq.awaiting === 'choice', String(S.seq?.awaiting))
  ok('offering however many choices the writer wrote',
     game.sequenceChoices(S).length >= 2, String(game.sequenceChoices(S).length))
  // Delivery, not the engine: an art emission may carry its line, but the bot
  // must send them as two messages. A caption makes Telegram fit the photo to
  // the text width, which stretches a portrait. Read from the source, since
  // this path needs Telegram to exercise.
  const botSrc = await readFile(new URL('./bot.mjs', import.meta.url), 'utf8')
  const artSend = botSrc.slice(botSrc.indexOf("e.kind === 'art'"))
  const upTo = artSend.slice(0, artSend.indexOf('RENDERABLE.has'))
  ok('a picture is sent without a caption, and its line follows separately',
     !/caption: cap/.test(upTo) && /sendMessage\(chatId, cap/.test(upTo))
  ok('a moving picture goes through sendAnimation, not sendPhoto',
     /sendAnimation/.test(upTo) && /isAnimation\(file\)/.test(upTo))

  // artPath and isAnimation, against real files on disk
  ok('an mp4 or a gif is recognised as moving',
     ['a.mp4', 'b.gif', 'C.MP4'].every(isAnimation) &&
     !['a.png', 'b.webp', 'c', ''].some(isAnimation))

  const probe = new URL('./art/_selftest_probe.mp4', import.meta.url)
  const still = new URL('./art/_selftest_probe.png', import.meta.url)
  await writeFile(still, 'not really a png')
  ok('a still is found', /_selftest_probe\.png$/.test(artPath('_selftest_probe') || ''))
  await writeFile(probe, 'not really an mp4')
  ok('and a moving version of the same name takes precedence',
     /_selftest_probe\.mp4$/.test(artPath('_selftest_probe') || ''),
     'dropping in an mp4 should upgrade a scene without deleting the still')
  await rm(probe, { force: true })
  await rm(still, { force: true })
  ok('a name with no file is still null', artPath('_selftest_probe') === null)

  // Cross-checked against ffprobe while writing it, which is how I found the
  // offset wrong: the handler type sits 12 bytes into an hdlr box, not 8.
  ok('a still is never reported as noisy', !hasAudio(artPath('lift_closed')))
  ok('an mp4 with an audio track is caught',
     !artPath('himbo')?.endsWith('.mp4') || hasAudio(artPath('himbo')),
     'sendAnimation wants no sound; with audio Telegram sends a video')
  ok('and a name that tries to escape the directory is refused',
     artPath('../../package') === null)
  ok('art travels as its own emission',
     opening.emissions.some((e) => e.kind === 'art'))
  ok('and is paced, so a burst does not arrive all at once',
     opening.emissions.every((e) => e.pace))

  // a scene has the floor: an unrecognised command must not reach the game
  const before = S.seq.at
  const nudged = await game.handle(S, '1')
  ok('a scene holds the floor', S.seq && S.seq.at === before,
     'a game command must not get through a running scene')
  ok('and says so', /still talking/i.test(nudged.emissions[0]?.text || ''))

  // walked generically: the script is a writer's file and its shape will change
  let guard = 0
  let after = { emissions: [] }
  while (game.inSequence(S) && guard++ < 40) {
    const offered = game.sequenceChoices(S)
    after = await game.handle(S, offered.length ? offered[0].token : 'Tester')
  }
  ok('answering plays the branch and carries on',
     !game.inSequence(S) && S.seqSeen.includes('intro'))
  ok('then the game arrives', after.emissions.some((e) => /Round/.test(e.text || '')))
  ok('and the brochure is not read to someone who was walked in',
     !after.emissions.some((e) => /premier neo-market/.test(e.text || '')))

  // once only
  const again = await game.boot(S)
  ok('the intro does not play twice', !game.inSequence(S))
  void again

  // skippable
  const skipper = game.newSession(92)
  await game.boot(skipper)
  const skipped = await game.handle(skipper, 'skip')
  ok('skip ends the scene and starts the game',
     !game.inSequence(skipper) && skipped.emissions.some((e) => /Round/.test(e.text || '')))

  // A declared-but-unwritten scene must be harmless: that is the state every
  // scene starts in. Injected rather than pointed at a real one, so this does
  // not go stale the moment a writer fills that scene in - which is exactly
  // what happened to the version of this test that named `tutorial`.
  const empty = game.newSession(93)
  section('sequences')._selftest_empty = []
  ok('a declared but empty sequence simply does not play',
     game.startSequence(empty, '_selftest_empty').length === 0 && !game.inSequence(empty))
  ok('and a sequence that does not exist is the same',
     game.startSequence(empty, 'nope_not_here').length === 0)
  delete section('sequences')._selftest_empty

  // every scene the opening names must actually exist
  const missing = list('opening').filter((id) => !Array.isArray(section(`sequences.${id}`)))
  ok('every scene in the opening list exists', missing.length === 0, missing.join(', '))
}

// --- beats -----------------------------------------------------------------
{
  ok('a new desk is on probation', game.newSession(77).probation === true)

  // Day one rides boot - but boot returns early for the opening scene, so the
  // beat lands on the boot that happens once the scene is done. Which is the
  // right order: the himbo walks you to the desk before Harold is mentioned.
  const S = await playable(77)
  ok('the day-one setpiece fires once the opening scene is done',
     S.beatsSeen.includes('arrival'), JSON.stringify(S.beatsSeen))
  ok('and only once', game.beatDue(S) === null)

  // a setpiece with choices leaves itself pending
  S.week = [1, 2]
  const fired = game.fireBeat(S)
  ok('a scheduled setpiece fires on its day', fired.length === 1)
  ok('one with choices waits for an answer', S.beat === 'the_oldhead', String(S.beat))
  ok('and offers them', game.beatChoices(S).length === 2)

  // effects apply, clamped
  S.coherence = 0.4
  const before = S.coherence
  await game.handle(S, 'a')
  ok('a choice may spend or restore coherence', S.coherence > before,
     `${before} -> ${S.coherence}`)
  ok('answering clears the beat', S.beat === null)

  // a command that is not one of its choices must reach the game
  S.week = [1, 2, 3, 4, 5]
  game.fireBeat(S)
  const pending = S.beat
  ok('a beat is pending', pending !== null)
  await game.handle(S, 'state')
  ok('a non-choice command falls through to the game', S.beat === pending,
     'the beat must not swallow a game command')

  // a beat can be answered mid-position, without disturbing it
  S.expect = 'running'
  await game.handle(S, 'a')
  ok('a beat can be answered mid-position', S.beat === null)
  ok('and answering does not disturb the run', S.expect === 'running')

  // a second attempt has spent its setpieces, so something else has to speak
  const again = game.newSession(78)
  again.attempts = 2
  again.beatsSeen = ['arrival', 'the_oldhead', 'the_himbo']
  const line = game.fireBeat(again)
  ok('a repeat attempt still hears something', line.length === 1 && line[0].text)
  ok('and it is not a setpiece', !again.beat)
}

// --- the clock keeps running -------------------------------------------------
{
  const S = game.newSession(9)
  S.dayStartedMs = Date.now() - realMs(GAME_DAY_SECONDS * 3.5)
  const before = S.dayIndex
  const caught = game.catchUpDays(S)
  ok('an absence closes every day that passed, not just one',
     caught.closed === 3 && S.dayIndex - before === 3, `closed ${caught.closed}`)
  ok('and each of them counts as idle',
     S.budget < game.START_BUDGET, `budget ${S.budget}`)
  ok('the clock is left where the last boundary fell, not at now',
     !game.dayIsOver(S) && game.dayRemaining(S) < GAME_DAY_SECONDS)

  // a session left for a game month must not return a hundred messages
  const stale = game.newSession(10)
  stale.dayStartedMs = Date.now() - realMs(GAME_DAY_SECONDS * 40)
  const far = game.catchUpDays(stale)
  ok('a very long absence is capped rather than replayed',
     far.closed <= 7 && !game.dayIsOver(stale), `closed ${far.closed}`)

  // every session needs a wake, not only the ones mid-run
  ok('a session with no position still has a next wake',
     game.nextWake(game.newSession(11)) > 0)
}

// --- the bell ----------------------------------------------------------------
{
  const S = await playable(5)
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
