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
const { renderEmission, artPath, isAnimation, hasAudio, stickerOf, STICKER_SIDE } =
  await import('./render.mjs')

// What the round panel opens with, read from copy rather than spelled out here.
// Three assertions used to look for "Round", which is how they all broke at
// once when that became "Investment Options". If a variable is ever put in this
// line the match will stop working and say so, which is the failure worth
// having.
const ROUND_HEAD = String(section('scenes.round')).split('\n').find((l) => l.trim()).trim()
const isRoundPanel = (t) => typeof t === 'string' && t.includes(ROUND_HEAD)

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
  ok('then the game arrives', after.emissions.some((e) => isRoundPanel(e.text)))
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
     !game.inSequence(skipper) && skipped.emissions.some((e) => isRoundPanel(e.text)))

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

  // Read from the schedule, never named. The version of this block that named
  // `arrival` and `the_oldhead` went red the moment the schedule was rewritten
  // around change1 and the_himbo - the same way the one that named `tutorial`
  // did, and for the same reason. Which day carries which setpiece is a
  // writer's decision; that a scheduled day fires exactly once, and that a
  // setpiece with choices waits, is the engine's.
  const schedule = section('beats.schedule') || {}
  const days = Object.keys(schedule).map(Number).sort((a, b) => a - b)
  const onDay = (n) => { const S = game.newSession(77); S.week = Array.from({ length: n - 1 }, (_, i) => i); return S }
  ok('the week has setpieces scheduled in it', days.length > 0, JSON.stringify(schedule))

  // Day one rides boot - but boot returns early for the opening scene, so a
  // day-one beat lands on the boot that happens once the scene is done. Asserted
  // only when day one carries one: an opening with nothing on it is a valid
  // schedule, and this used to fail simply for being written that way.
  const S = await playable(77)
  if (schedule['1']) {
    ok('a day-one setpiece fires once the opening scene is done',
       S.beatsSeen.includes(schedule['1']), JSON.stringify(S.beatsSeen))
    ok('and only once', game.beatDue(S) === null)
  } else {
    ok('an opening day with nothing scheduled fires nothing',
       S.beatsSeen.length === 0, JSON.stringify(S.beatsSeen))
  }

  // every scheduled day fires its own setpiece, once
  for (const day of days) {
    const D = onDay(day)
    const out = game.fireBeat(D)
    ok(`day ${day} fires ${schedule[String(day)]}`,
       out.length === 1 && D.beatsSeen.includes(schedule[String(day)]),
       JSON.stringify(D.beatsSeen))
    ok(`and day ${day} does not fire it twice`, game.beatDue(D) === null)
  }

  // a setpiece with choices leaves itself pending. Whichever day happens to
  // carry one - there has to be one somewhere, or nothing is ever asked.
  // choices are a mapping of token -> {label, ...}, which is also where the
  // reply letters come from - so nothing here guesses at 'a'.
  const choicesOf = (id) => Object.entries(section(`beats.${id}.choices`) || {})
  const choiceDay = days.find((d) => choicesOf(schedule[String(d)]).length > 0)
  ok('some setpiece in the week asks something', choiceDay !== undefined)
  const withChoices = onDay(choiceDay)
  const fired = game.fireBeat(withChoices)
  ok('a scheduled setpiece fires on its day', fired.length === 1)
  ok('one with choices waits for an answer',
     withChoices.beat === schedule[String(choiceDay)], String(withChoices.beat))
  ok('and offers them', game.beatChoices(withChoices).length ===
     choicesOf(schedule[String(choiceDay)]).length)
  Object.assign(S, { week: withChoices.week, beat: withChoices.beat,
                     beatsSeen: withChoices.beatsSeen })

  // effects apply, clamped. Which letter carries the coherence, and its sign,
  // are the writer's - so the assertion is that the number moves the way the
  // copy says, not that it goes up.
  const written = choicesOf(schedule[String(choiceDay)])
  S.coherence = 0.4
  await game.handle(S, written[0][0])
  ok('answering clears the beat', S.beat === null)

  // Effects are tested against a beat written here, not against whatever the
  // schedule happens to hold. Whether a choice spends coherence is a writer's
  // decision - today none of them do - and asserting that one does is the same
  // mistake as naming `arrival` was. What must hold is that when a choice
  // carries an effect the engine applies it, and clamps it at both ends.
  section('beats')._selftest_choice = {
    text: 'a test beat',
    choices: {
      a: { label: 'take some back', coherence: 0.2 },
      b: { label: 'spend far more than there is', coherence: -0.9 },
      c: { label: 'nothing at all' },
    },
  }
  const fx = async (token, from) => {
    const T = game.newSession(79)
    T.coherence = from
    T.beat = '_selftest_choice'
    await game.handle(T, token)
    return T
  }
  ok('a choice restores coherence', Math.abs((await fx('a', 0.4)).coherence - 0.6) < 1e-9)
  ok('a choice spends it', Math.abs((await fx('b', 0.95)).coherence - 0.05) < 1e-9)
  ok('and cannot spend past nothing', (await fx('b', 0.5)).coherence === 0)
  ok('nor restore past whole', (await fx('a', 0.95)).coherence === 1)
  ok('a choice with no effect leaves it alone', (await fx('c', 0.4)).coherence === 0.4)
  ok('every choice clears the beat', (await fx('c', 0.4)).beat === null)
  delete section('beats')._selftest_choice

  // a command that is not one of its choices must reach the game
  const another = onDay(choiceDay)
  game.fireBeat(another)
  Object.assign(S, { week: another.week, beat: another.beat, beatsSeen: another.beatsSeen })
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
  again.beatsSeen = days.map((d) => schedule[String(d)])
  const line = game.fireBeat(again)
  ok('a repeat attempt still hears something', line.length === 1 && line[0].text)
  ok('and it is not a setpiece', !again.beat)
}

// --- a scene that is not there ----------------------------------------------
{
  // Three ways a session used to strand, all of them fatal and all of them
  // silent: the player's messages did nothing, the day's messages kept coming,
  // and `skip` was the only way out. These are the states, verbatim, that came
  // off disk when it happened.
  const opening = list('opening')

  // 1. expect pointing at a scene that finished. What the old boot wrote every
  //    time a scene had nothing to answer in it.
  const stranded = game.newSession(201)
  stranded.expect = 'sequence'
  stranded.seq = null
  stranded.seqSeen = opening.slice(0, -1)
  const freed = await game.handle(stranded, 'hello')
  ok('a finished scene left in expect does not strand the session',
     stranded.expect !== 'sequence' || game.inSequence(stranded),
     `expect ${stranded.expect}, scene ${stranded.seq && stranded.seq.id}`)
  ok('and it picks up at the scene that had not played',
     game.inSequence(stranded) && stranded.seq.id === opening[opening.length - 1],
     String(stranded.seq && stranded.seq.id))
  ok('and says something rather than nothing', freed.emissions.length > 0)

  // 2. standing in a scene that has since been renamed in copy
  const renamed = game.newSession(202)
  renamed.expect = 'sequence'
  renamed.seq = { id: 'a_scene_that_used_to_exist', at: 2, awaiting: 'choice' }
  const rescued = await game.handle(renamed, 'a')
  ok('a scene renamed under a player does not strand them',
     renamed.seq === null || renamed.seq.id !== 'a_scene_that_used_to_exist',
     String(renamed.seq && renamed.seq.id))
  ok('and the game speaks again', rescued.emissions.length > 0)

  // 3. expect left on 'boot', which endSequence writes and nothing dispatched
  const booting = game.newSession(203)
  booting.expect = 'boot'
  booting.seqSeen = opening
  booting.rounds = 2
  const rebooted = await game.handle(booting, 'anything')
  ok("expect 'boot' is a state the game can leave",
     booting.expect !== 'boot', `expect ${booting.expect}`)
  ok('and it comes back with the game', rebooted.emissions.some((e) => isRoundPanel(e.text)))
}

// --- price is a picture, not a payout ---------------------------------------
{
  // The book still orders the holdings - more contracts is dearer - but the
  // mapping is compressed, so a thirteenfold book is nowhere near a
  // thirteenfold quote. Asserted as a relationship, not a number: the exponent
  // is a tuning knob and MW_PRICE_GAMMA moves it.
  const at = (book) => game.basePrice({ id: 'fixed', book: [book] }, 0)
  ok('a bigger book is dearer', at(9) > at(1), `${at(1).toFixed(0)} -> ${at(9).toFixed(0)}`)
  ok('the same book is the same price every time', at(4) === at(4))
  ok('the quote is compressed against the book',
     at(9) / at(1) < (1 + 9) / (1 + 1),
     `${(at(9) / at(1)).toFixed(2)}x quote for a 5x book`)

  // and none of it reaches the money. A position returns stake x (1 + return),
  // and that return is a ratio of two quotes on the same base - so the base
  // divides out and squashing it cannot move anyone's P/L.
  const ratio = (base) => game.quote(base, 0.2) / game.quote(base, 0.6)
  ok('a payout does not depend on what a holding costs',
     Math.abs(ratio(90) - ratio(9000)) < 1e-12,
     `${ratio(90)} vs ${ratio(9000)}`)
}

// --- a probation week ends as a scene ---------------------------------------
{
  const week = (S) => {
    const said = []
    for (let d = 0; d < 7; d++) said.push(...game.endOfDay(S))
    return said
  }
  // The scenes are written here rather than read from copy. Whether a verdict
  // has anyone in it is a writer's decision; what must hold is that the engine
  // gives the scene the floor and takes it back afterwards.
  const seqs = section('sequences')
  const saved = { fail: seqs.probation_failed, again: seqs.probation_failed_again }
  seqs.probation_failed = [{
    speaker: 'Navinder', text: 'Seven days. {total}.',
    choices: { a: { label: 'say nothing', reply: '_You say nothing._', coherence: -0.1 } },
  }]
  seqs.probation_failed_again = [{ text: 'Again. {failures} of them.' }]

  const S = game.newSession(101)
  S.seqSeen = list('opening'); S.rounds = 1; S.coherence = 0.9
  const said = week(S)
  ok('a failed week plays its scene', said.some((e) => /Seven days/.test(e.text || '')))
  ok('and the scene has the floor', S.expect === 'sequence' && game.inSequence(S))
  ok('so next week is not offered underneath it', !said.some((e) => isRoundPanel(e.text)))
  ok('the scene can read the week it is about',
     said.some((e) => /Seven days\. [+-]/.test(e.text || '')),
     said.map((e) => e.text).join(' | ').slice(0, 80))

  const answered = await game.handle(S, 'a')
  ok('answering a verdict may cost coherence', Math.abs(S.coherence - 0.8) < 1e-9,
     `0.900 -> ${S.coherence.toFixed(3)}`)
  ok('and then the new week is offered',
     answered.emissions.some((e) => isRoundPanel(e.text)))
  ok('a failure keeps the desk on probation', S.probation === true)

  S.week = []; S.history = []
  ok('a repeat failure plays the shorter scene',
     week(S).some((e) => /^Again\./m.test(e.text || '')))

  // with nothing written for a repeat, the full scene plays again rather than
  // nothing at all
  seqs.probation_failed_again = []
  const T = game.newSession(103)
  T.seqSeen = list('opening'); T.rounds = 1; T.attempts = 4
  ok('an unwritten repeat falls back to the full scene',
     week(T).some((e) => /Seven days/.test(e.text || '')))

  // and a profitable week ends probation for good
  const P = game.newSession(102)
  P.seqSeen = list('opening'); P.rounds = 1
  P.week = [100, 100, 100, 100, 100, 100]
  const won = game.endOfDay(P)
  ok('a profitable week passes', P.probation === false)
  ok('and the pass has its own scene', won.some((e) => /off probation/i.test(e.text || '')))

  Object.assign(seqs, { probation_failed: saved.fail, probation_failed_again: saved.again })
}

// --- /help says the voice again ---------------------------------------------
{
  const nodes = section(`sequences.${game.HELP_SCENE}`) || []
  ok('the help scene has something to say', nodes.length > 0)

  const S = game.newSession(104)
  S.seqSeen = list('opening'); S.rounds = 2
  await game.boot(S)
  const was = { expect: S.expect, seen: JSON.stringify(S.seqSeen) }
  const helped = await game.handle(S, 'help')
  // every line of the scene, plus the list of keys under it
  ok('/help plays every line of it', helped.emissions.length === nodes.length + 1,
     `${helped.emissions.length} messages for ${nodes.length} nodes`)
  ok('/help does not enter the scene', !game.inSequence(S))
  ok('/help leaves expect alone', S.expect === was.expect, `${was.expect} -> ${S.expect}`)
  ok('/help does not mark the scene as seen', JSON.stringify(S.seqSeen) === was.seen)

  // the point of narrating rather than playing: it is safe mid-position
  S.expect = 'running'
  S.run = { target: 0 }
  const midway = await game.handle(S, 'help')
  ok('/help mid-position leaves the position standing',
     S.expect === 'running' && !game.inSequence(S) && S.run !== null)
  ok('and still says it all', midway.emissions.length === nodes.length + 1)
}

// --- art travels as stickers -------------------------------------------------
{
  // Every still in art/ has to survive the conversion, because the failure is
  // silent: canvas hands back a valid, correctly sized, completely empty webp
  // if the decode was not ready. Weight is the only tell, so weight is checked.
  const { readdirSync } = await import('node:fs')
  const { loadImage, createCanvas } = await import('@napi-rs/canvas')
  const stills = readdirSync(new URL('./art/', import.meta.url))
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))

  ok('there is art to send', stills.length > 0)

  for (const f of stills) {
    const name = f.replace(/\.[^.]+$/, '')
    const webp = await stickerOf(artPath(name))
    const img = await loadImage(webp)
    const long = Math.max(img.width, img.height)
    const short = Math.min(img.width, img.height)

    // Telegram's rule: one side exactly 512, the other 512 or less.
    ok(`${name} is a sticker Telegram will take`,
       long === STICKER_SIDE && short <= STICKER_SIDE,
       `${img.width}x${img.height}`)
    ok(`${name} is a webp`, webp.slice(8, 12).toString('ascii') === 'WEBP')

    // and it has to still be the same picture. Compared against the source
    // rather than against a number: how much of a drawing is inked and how
    // much is see-through is the artist's business - lift_closed is a full
    // frame with no cut-out at all, tower.png is blank - so what is asserted
    // is that converting does not change it.
    const share = async (f) => {
      const i = await loadImage(f)
      const c = createCanvas(i.width, i.height)
      const ctx = c.getContext('2d')
      ctx.drawImage(i, 0, 0)
      const px = ctx.getImageData(0, 0, i.width, i.height).data
      let ink = 0, clear = 0
      for (let j = 3; j < px.length; j += 4) {
        if (px[j] > 5) ink += 1
        if (px[j] < 250) clear += 1
      }
      const n = i.width * i.height
      return { ink: (100 * ink) / n, clear: (100 * clear) / n }
    }
    const got = await share(webp)
    const want = await share(artPath(name))
    // Five points of slack for the resample: a soft edge moves a little when
    // 1024 pixels become 512.
    ok(`${name} keeps its picture through the conversion`,
       Math.abs(got.ink - want.ink) < 5,
       `${want.ink.toFixed(0)}% inked before, ${got.ink.toFixed(0)}% after, ` +
       `${(webp.length / 1024).toFixed(1)}KB`)
    ok(`${name} keeps its transparency through the conversion`,
       Math.abs(got.clear - want.clear) < 5,
       `${want.clear.toFixed(0)}% non-opaque before, ${got.clear.toFixed(0)}% after`)
  }

  // the cache must not hand back a stale picture, nor rebuild every send
  const one = artPath(stills[0].replace(/\.[^.]+$/, ''))
  const a = await stickerOf(one)
  const b = await stickerOf(one)
  ok('a second send reuses the conversion', a === b)
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
  const round = out.findIndex(isRoundPanel)
  ok('the day closes before the next round is offered',
     bell >= 0 && round >= 0 && bell < round, `bell at ${bell}, round at ${round}`)
  ok('the new round reads the new budget',
     out[round]?.includes(S.budget.toLocaleString('en-GB')), out[round]?.split('\n')[2])
}

await rm(SCRATCH, { recursive: true, force: true })
console.log(failures ? `\n  ${failures} failed\n` : '\n  all good\n')
process.exit(failures ? 1 : 0)
