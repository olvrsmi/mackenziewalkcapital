// bot.mjs - the Telegram surface.
//
// grammY over long polling, so this runs anywhere without a public URL or a
// certificate. The rules live in game.mjs and know nothing about Telegram; this
// file turns emissions into messages, `expect` into inline keyboards, and taps
// back into the same short tokens a player could have typed.
//
//   TELEGRAM_BOT_TOKEN   required, from @BotFather
//   TELEGRAM_BOT_TOKEN_LOCAL  used instead when MW_LOCAL=1 (npm run dev)
//   MW_TIME_SCALE        game seconds per real second (see time.mjs)
//   MW_PYTHON            interpreter for the model
//   MW_STATE_DIR         where saved games live
//   MW_ALLOW             optional comma-separated Telegram user ids; if set,
//                        only those may play

import './env.mjs'   // must come first: it fills process.env for the rest

import { Bot, InlineKeyboard, InputFile, GrammyError, HttpError } from 'grammy'

import * as game from './game.mjs'
import { t, loadCopy, watchCopy, copyInfo, holding, moment } from './copy.mjs'
import * as store from './sessions.mjs'
import { renderEmission, RENDERABLE } from './render.mjs'
import { modelInfo } from './model.mjs'
import { timeInfo, describeReal } from './time.mjs'
import { logEvent, logFile } from './log.mjs'

// Telegram allows one long poll per token and a second one evicts the first, so
// a laptop and a server cannot share a bot. MW_LOCAL picks the development one.
const LOCAL = process.env.MW_LOCAL === '1'
const TOKEN_VAR = LOCAL ? 'TELEGRAM_BOT_TOKEN_LOCAL' : 'TELEGRAM_BOT_TOKEN'
const TOKEN = process.env[TOKEN_VAR]
if (!TOKEN) {
  console.error(`\n  ${TOKEN_VAR} is not set.`)
  console.error(LOCAL
    ? '  npm run dev needs a second bot, so it does not fight the deployed one.'
    : '  Create a bot with @BotFather, then put its token in .env.')
  console.error('  See .env.example.\n')
  process.exit(78)          // EX_CONFIG: systemd will not restart on this
}

const ALLOW = (process.env.MW_ALLOW || '').split(',').map((s) => s.trim())
  .filter(Boolean)

export const bot = new Bot(TOKEN)

// ---------------------------------------------------------------------------
// Text. Telegram's MarkdownV2 needs _*[]()~`>#+-=|{}.! escaped, which circuit
// ids like grover_n2 and values like -1.000 both trip. HTML mode only cares
// about & < >, so the rules emit a small markdown subset and it is converted
// here.
// ---------------------------------------------------------------------------

function toHtml (s) {
  return String(s)
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    // Emphasis must survive a holding name that contains an underscore. With
    // e_1 in the text, a naive [^_]+ body stops at that underscore and the whole
    // italic silently fails, leaving the delimiters on screen. So the body may
    // contain an underscore when it is inside a word, and only an underscore
    // followed by a non-word character can close the run.
    .replace(/(^|[^\w`])_((?:[^_\n`]|_(?=\w))+)_(?![\w])/g, '$1<i>$2</i>')
}

// ---------------------------------------------------------------------------
// Keyboards. Derived from `expect`, so game.mjs stays free of any UI notion.
// Every button sends the same token a player could have typed instead.
// ---------------------------------------------------------------------------

function keyboardFor (S) {
  const k = new InlineKeyboard()
  // A pending beat's choices come first and sit on their own row. They are
  // offered whatever the game state is, including mid-position, because a beat
  // does not interrupt a run and its choice can be answered whenever.
  const beat = game.beatChoices(S)
  if (beat.length) {
    for (const c of beat) k.text(c.label, c.token)
    k.row()
  }
  switch (S.expect) {
    case 'world': {
      (S.worlds || []).forEach((w, i) => {
        const n = w.info.n
        k.text(t('buttons.world',
          { index: i + 1, world: w.name, opportunities: n }), `${i + 1}`).row()
      })
      k.text(t('buttons.marketplace'), 'm')
      return k
    }
    case 'invest':
      k.text(t('buttons.invest'), 'i').text(t('buttons.observe'), 'o')
      if (S.readoutIndex === 0) k.text(t('buttons.leave'), 'l')
      return k
    case 'target': {
      const n = S.world?.info?.n || 0
      for (let q = 0; q < n; q++) {
        k.text(t('buttons.qubit',
            { index: q, holding: holding(q, S.world?.holdings) }), `${q}`)
        if ((q + 1) % 4 === 0 && q + 1 < n) k.row()
      }
      return k
    }
    case 'exit': {
      const last = (S.world?.readouts || 1) - 1
      for (let r = S.readoutIndex + 1; r <= last; r++) {
        k.text(t(r === last ? 'buttons.exit_end' : 'buttons.exit_point',
                 { readout: r, moment: moment(r) }), `${r}`)
        if ((r - S.readoutIndex) % 3 === 0 && r < last) k.row()
      }
      return k
    }
    case 'running':
      // Nothing here is actionable while a position is open, and repeating the
      // three worlds under every readout was just clutter. Old messages keep
      // their locked buttons, so the 'locked' callback still has to answer.
      return k.text(t('buttons.marketplace'), 'm').text(t('buttons.status'), 'state')
    case 'stake': {
      const money = Math.floor(S.balance)
      const picks = [...new Set([100, 250, 500, Math.floor(money / 2), money])]
        .filter((v) => v >= 1 && v <= money)
        .sort((a, b) => a - b)
      picks.forEach((v, i) => {
        k.text(t(v === money ? 'buttons.all_stake' : 'buttons.stake',
                 { amount: `${v.toLocaleString('en-GB')}G` }), `${v}`)
        if ((i + 1) % 3 === 0) k.row()
      })
      return k
    }
    case 'market':
      return k.text(t('buttons.buy'), 'b').text(t('buttons.leave'), 'l')
    case 'buy':
      return k.text('1', '1').text('2', '2').text('5', '5').text('10', '10')
    case 'confirm_exit':
      return k.text(t('buttons.hold_anyway'), 'y')
        .text(t('buttons.choose_again'), 'n')
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Emission -> Telegram
// ---------------------------------------------------------------------------

/**
 * Send one thing, retrying transient failures.
 *
 * A network blip must not cost a round: grammY surfaces those as plain errors,
 * and without a retry the scheduled step throws, the next timer is never armed
 * and the run dies silently mid-flight. Client errors (blocked, chat gone) are
 * permanent and rethrown immediately so the caller can stop scheduling.
 */
async function sendWithRetry (fn, chatId, attempts = 3) {
  let wait = 1000
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const code = e?.error_code
      const permanent = code === 400 || code === 403 || code === 404
      logEvent('send_failed', { chat: chatId, code, permanent,
                                attempt: i, error: e?.description || e?.message })
      if (permanent || i >= attempts) throw e
      console.warn(`  ${chatId}: send failed (${e?.description || e?.message}), ` +
                   `retry ${i}/${attempts - 1} in ${wait}ms`)
      await new Promise((r) => setTimeout(r, wait))
      wait *= 3
    }
  }
}

async function deliver (chatId, emissions, S, { keyboard = true } = {}) {
  for (let i = 0; i < emissions.length; i++) {
    const e = emissions[i]
    const last = i === emissions.length - 1
    // A progressive acknowledgement is sent while `expect` still describes the
    // question just answered, so attaching a keyboard would repeat the buttons
    // the player has only now used.
    const reply_markup = keyboard && last ? keyboardFor(S) : undefined

    if (e.kind === 'text') {
      await sendWithRetry(() => bot.api.sendMessage(chatId, toHtml(e.text),
        { parse_mode: 'HTML', reply_markup }), chatId)
    } else if (RENDERABLE.has(e.kind)) {
      await bot.api.sendChatAction(chatId, 'upload_photo').catch(() => {})
      const t0 = process.hrtime.bigint()
      const png = renderEmission(e)
      logEvent('render', { chat: chatId, kind: e.kind, n: e.n,
                           ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
                           bytes: png.length })
      // A reading and the picture of it are one thing, so they travel as one
      // message. Telegram caps a caption at 1024 characters; a post that
      // somehow carries more falls back to sending them separately.
      const cap = e.caption ? toHtml(e.caption) : null
      const fits = cap !== null && cap.length <= 1024
      if (cap !== null && !fits) {
        await sendWithRetry(() => bot.api.sendMessage(chatId, cap,
          { parse_mode: 'HTML' }), chatId)
      }
      await sendWithRetry(() => bot.api.sendPhoto(chatId,
        new InputFile(png, 'plot.png'),
        { reply_markup, ...(fits ? { caption: cap, parse_mode: 'HTML' } : {}) }),
        chatId)
    } else {
      // Not throwing: one unknown emission should not lose the rest of a turn.
      // But it must not vanish either - that would be a message the player was
      // meant to get, gone with nothing said anywhere.
      console.error(`  ${chatId}: no way to deliver a '${e.kind}' emission`)
      logEvent('undeliverable', { chat: chatId, kind: e.kind })
    }
  }
}

// ---------------------------------------------------------------------------
// Turn handling. One queue per chat so a fast tapper cannot interleave two
// handlers over the same session.
// ---------------------------------------------------------------------------

const queues = new Map()

function enqueue (chatId, job) {
  const prev = queues.get(chatId) || Promise.resolve()
  const next = prev.then(job, job).catch(async (e) => {
    // A turn that dies silently looks exactly like a frozen game to the player,
    // and e.message alone gives nothing to debug from - log the stack, then say
    // so in the chat so they know to send something rather than sit waiting.
    console.error(`  ${chatId}: turn failed:`, e?.stack || e?.message || e)
    logEvent('turn_failed', { chat: chatId, error: e?.message || String(e),
                              stack: (e?.stack || '').split('\n').slice(0, 4).join(' | ') })
    await bot.api.sendMessage(chatId, t('scenes.turn_failed'),
                              { parse_mode: 'HTML' }).catch(() => {})
  })
  queues.set(chatId, next)
  return next
}

/**
 * The unprompted half of the game: whatever this session needs, when it needs
 * it, with nobody having asked.
 *
 * One timer per chat covers both clocks. A wake closes any day that has ended,
 * releases any readout that has come due, sends whatever that produced, and
 * arms the next wake - so a day ends on time even for a player who has not
 * opened the chat in three days, and a position still reports on its own.
 */
function fireFor (chatId) {
  return () => enqueue(chatId, async () => {
    const S = await store.load(chatId)
    if (!S) return
    const t0 = process.hrtime.bigint()
    const emissions = []

    // days first: the bell closes a position, so a run stepped before its day
    // was closed would settle into a day that had already ended
    const caught = game.catchUpDays(S)
    emissions.push(...caught.emissions)

    let done = false
    if (S.expect === 'running' && S.run) {
      await game.hydrate(S)          // a resumed run ends by offering worlds
      const r = game.step(S)
      emissions.push(...r.emissions)
      done = r.done
    }

    logEvent('wake', { chat: chatId, days: caught.closed, done,
                       emissions: emissions.length,
                       ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6) })

    let fatal = false
    if (emissions.length) {
      try {
        await deliver(chatId, emissions, S)
      } catch (e) {
        // The state has already advanced, so the post is lost either way. Keep
        // the session alive unless the chat itself is gone.
        fatal = [400, 403, 404].includes(e?.error_code)
        console.error(`  ${chatId}: wake delivery failed${fatal ? ' permanently' : ''}: ` +
                      `${e?.description || e?.message}`)
      }
    }
    await store.save(chatId, S)
    if (fatal) {
      console.error(`  ${chatId}: no longer waking this session — the chat is unreachable`)
    } else {
      store.schedule(chatId, { kind: 'wake', ms: game.nextWake(S) }, fireFor(chatId))
    }
  })
}

async function ensureSession (chatId) {
  let S = await store.load(chatId)
  if (!S) {
    S = game.newSession(Number(chatId) ^ Date.now())
    store.put(chatId, S)
    const b = await game.boot(S)
    await store.save(chatId, S)
    return { S, emissions: b.emissions, fresh: true }
  }
  return { S, emissions: [], fresh: false }
}

async function handleToken (chatId, text) {
  return enqueue(chatId, async () => {
    let S = await store.load(chatId)
    if (!S) {
      const started = await ensureSession(chatId)
      await deliver(chatId, started.emissions, started.S)
      return
    }
    await game.hydrate(S)          // re-hydrate after a restart
    const t0 = process.hrtime.bigint()
    const r = await game.handle(S, text, async (early) => {
      await deliver(chatId, early, S, { keyboard: false })
      // the work that follows is a model call of about a second
      await bot.api.sendChatAction(chatId, 'upload_photo').catch(() => {})
    })
    await deliver(chatId, r.emissions, S)
    // one wake covers both clocks, so a turn re-derives when the next thing is
    // due rather than arming a readout and hoping the day is covered too
    store.schedule(chatId, { kind: 'wake', ms: game.nextWake(S) }, fireFor(chatId))
    logEvent('turn', { chat: chatId, cmd: text.slice(0, 24),
                      expect: S.expect, day: S.dayIndex, round: S.rounds,
                      emissions: r.emissions.length,
                      ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6) })
    await store.save(chatId, S)
  })
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

bot.use(async (ctx, next) => {
  if (ALLOW.length && !ALLOW.includes(String(ctx.from?.id))) {
    if (ctx.chat) {
      await ctx.reply('This prototype is not open just now.').catch(() => {})
    }
    return
  }
  return next()
})

bot.command('start', async (ctx) => {
  const chatId = String(ctx.chat.id)
  store.forget(chatId)
  const S = game.newSession(Number(chatId) ^ Date.now())
  store.put(chatId, S)
  const b = await game.boot(S)
  await deliver(chatId, b.emissions, S)
  await store.save(chatId, S)
})

bot.command('help', (ctx) => handleToken(String(ctx.chat.id), 'help'))
bot.command('status', (ctx) => handleToken(String(ctx.chat.id), 'state'))
bot.command('market', (ctx) => handleToken(String(ctx.chat.id), 'm'))

bot.command('time', async (ctx) => {
  const t = timeInfo()
  await ctx.reply(toHtml(
    `**Time**\nScale ${t.scale}x — one game day is ` +
    `${describeReal(t.gameDaySeconds)} of real time.\n` +
    `A spent qubit recharges over ${describeReal(1 / game.BASE_REGEN)}.`),
    { parse_mode: 'HTML' })
})

bot.on('callback_query:data', async (ctx) => {
  const chatId = String(ctx.chat?.id ?? ctx.from.id)
  if (ctx.callbackQuery.data === 'locked') {
    const S = await store.load(chatId)
    await ctx.answerCallbackQuery({
      text: t('buttons.locked_toast', {
        world: S?.world?.name || 'a world',
        until: S?.run ? moment(S.run.exitAt) : '?',
      }),
      show_alert: false,
    }).catch(() => {})
    return
  }
  await ctx.answerCallbackQuery().catch(() => {})
  await bot.api.sendChatAction(chatId, 'typing').catch(() => {})
  // the button carries the same token the player could have typed
  await handleToken(chatId, ctx.callbackQuery.data)
})

bot.on('message:text', async (ctx) => {
  const chatId = String(ctx.chat.id)
  await bot.api.sendChatAction(chatId, 'typing').catch(() => {})
  await handleToken(chatId, ctx.message.text)
})

bot.catch((err) => {
  const e = err.error
  if (e instanceof GrammyError) console.error('  telegram:', e.description)
  else if (e instanceof HttpError) console.error('  network:', e.message)
  else console.error('  bot error:', e)
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

try {
  await bot.api.setMyCommands([
    { command: 'start', description: 'begin, or start over' },
    { command: 'status', description: 'your qubit, coherence and balance' },
    { command: 'market', description: 'buy coherence regeneration' },
    { command: 'time', description: 'how fast game time is running' },
    { command: 'help', description: 'the command list' },
  ])
} catch (e) {
  // a wrong or revoked token is the likeliest first-run failure; say so plainly
  const badToken = e?.error_code === 401 || /401/.test(String(e?.description || e))
  const why = badToken
    ? `Telegram rejected the token (401 Unauthorized). Check ${TOKEN_VAR} ` +
      'in server/.env against what @BotFather gave you.'
    : `Could not reach Telegram: ${e?.description || e?.message || e}`
  console.error(`\n  ${why}\n`)
  // A rejected token is configuration and will not fix itself; an unreachable
  // Telegram is worth retrying, so let systemd restart that one.
  process.exit(badToken ? 78 : 1)
}

loadCopy()
watchCopy()

const resumed = await store.resumeAll(fireFor)
const clock = timeInfo()
console.log('\n  OFFICE 4B, 6 MACKENZIE WALK - telegram')
console.log(`  model    ${modelInfo().python}`)
console.log(`  time     ${clock.scale}x  ` +
            `(a game day is ${describeReal(clock.gameDaySeconds)}, ` +
            `a readout every ${describeReal(game.READOUT_GAME_SECONDS)})`)
console.log(`  posts    every ${describeReal(game.POST_GAME_SECONDS)}` +
            `${process.env.MW_POST_MS ? ' (pinned by MW_POST_MS)' : ''}`)
console.log(`  sessions ${resumed.sessions} saved, ${resumed.resumed} resumed`)
console.log(`  bot      ${LOCAL ? 'development (MW_LOCAL=1)' : 'deployed'}`)
if (ALLOW.length) console.log(`  allow    ${ALLOW.length} user id(s)`)
console.log(`  log      ${logFile() || 'disabled'}`)
console.log('  polling...\n')
logEvent('boot', {
  local: LOCAL, scale: clock.scale, gameDaySeconds: clock.gameDaySeconds,
  postMs: game.POST_MS, readoutGameSeconds: game.READOUT_GAME_SECONDS,
  sessions: resumed.sessions, resumed: resumed.resumed, allow: ALLOW.length,
  node: process.version, pid: process.pid,
})

try {
  await bot.start({ onStart: (me) => console.log(`  connected as @${me.username}\n`) })
} catch (e) {
  // Telegram allows exactly one long poll per token. A second instance does not
  // share the updates, it evicts the first - so this is nearly always a stray
  // process still running, and the game goes dead with no message to the player.
  logEvent('polling_stopped', { code: e?.error_code,
                                error: e?.description || e?.message || String(e) })
  if (e?.error_code === 409) {
    console.error('\n  409: another instance is already polling this token.' +
                  '\n  Stop it first:  pkill -f "node bot.mjs"\n')
  } else {
    console.error(`\n  polling stopped: ${e?.description || e?.message || e}\n`)
  }
  // Restarting into a token someone else holds just fights them, so stop.
  process.exit(e?.error_code === 409 ? 78 : 1)
}
