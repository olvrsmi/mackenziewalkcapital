// bot.mjs - the Telegram surface.
//
// grammY over long polling, so this runs anywhere without a public URL or a
// certificate. The rules live in game.mjs and know nothing about Telegram; this
// file turns emissions into messages, `expect` into inline keyboards, and taps
// back into the same short tokens a player could have typed.
//
//   TELEGRAM_BOT_TOKEN   required, from @BotFather
//   MW_TIME_SCALE        game seconds per real second (see time.mjs)
//   MW_PYTHON            interpreter for the model
//   MW_STATE_DIR         where saved games live
//   MW_ALLOW             optional comma-separated Telegram user ids; if set,
//                        only those may play

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bot, InlineKeyboard, InputFile, GrammyError, HttpError } from 'grammy'

// Node does not read .env on its own, and --env-file throws when the file is
// missing, so load it here: present values win over an already-set environment
// only if the environment has not set them.
function loadEnv () {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '.env')
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnv()

import * as game from './game.mjs'
import * as store from './sessions.mjs'
import { renderTraces, renderGatemap } from './render.mjs'
import { modelInfo } from './model.mjs'
import { timeInfo, describeReal } from './time.mjs'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  console.error('\n  TELEGRAM_BOT_TOKEN is not set.')
  console.error('  Create a bot with @BotFather, then:')
  console.error('    echo "TELEGRAM_BOT_TOKEN=..." > .env && npm start\n')
  process.exit(1)
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
    .replace(/(^|[^\w`])_([^_`]+)_(?![\w])/g, '$1<i>$2</i>')
}

// ---------------------------------------------------------------------------
// Keyboards. Derived from `expect`, so game.mjs stays free of any UI notion.
// Every button sends the same token a player could have typed instead.
// ---------------------------------------------------------------------------

function keyboardFor (S) {
  const k = new InlineKeyboard()
  switch (S.expect) {
    case 'world': {
      const names = (S.worlds || []).map((w, i) => [`${i + 1}. ${w.name}`, `${i + 1}`])
      for (const [label, data] of names) k.text(label, data).row()
      k.text('Marketplace', 'm').text('Wait', 't')
      return k
    }
    case 'invest':
      return k.text('Invest', 'i').text('Watch on', 'w')
    case 'target': {
      const n = S.world?.info?.n || 0
      for (let q = 0; q < n; q++) {
        k.text(`q${q}`, `${q}`)
        if ((q + 1) % 4 === 0 && q + 1 < n) k.row()
      }
      return k
    }
    case 'stake': {
      const money = Math.floor(S.money)
      const picks = [...new Set([100, 250, 500, Math.floor(money / 2), money])]
        .filter((v) => v >= 1 && v <= money)
        .sort((a, b) => a - b)
      picks.forEach((v, i) => {
        k.text(v === money ? `All ${v}G` : `${v}G`, `${v}`)
        if ((i + 1) % 3 === 0) k.row()
      })
      return k
    }
    case 'market':
      return k.text('Buy', 'b').text('Sell', 's').row().text('Wait', 't')
        .text('Leave', 'l')
    case 'buy':
      return k.text('5', '5').text('10', '10').text('25', '25').text('50', '50')
    case 'sell':
      return k.text('5', '5').text('10', '10').text('All', `${S.regenUnits}`)
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Emission -> Telegram
// ---------------------------------------------------------------------------

async function deliver (chatId, emissions, S) {
  for (let i = 0; i < emissions.length; i++) {
    const e = emissions[i]
    const last = i === emissions.length - 1
    const reply_markup = last ? keyboardFor(S) : undefined

    if (e.kind === 'text') {
      await bot.api.sendMessage(chatId, toHtml(e.text),
        { parse_mode: 'HTML', reply_markup })
    } else if (e.kind === 'traces' || e.kind === 'gatemap') {
      await bot.api.sendChatAction(chatId, 'upload_photo').catch(() => {})
      const png = e.kind === 'traces'
        ? renderTraces({ n: e.n, z: e.z, upto: e.upto,
            totalReadouts: e.totalReadouts, target: e.target,
            interventionAt: e.interventionAt, title: e.title })
        : renderGatemap({ n: e.n, layers: e.layers, cuts: e.cuts,
            nLayers: e.nLayers, title: e.title })
      await bot.api.sendPhoto(chatId, new InputFile(png, 'plot.png'),
        { reply_markup })
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
  const next = prev.then(job, job).catch((e) =>
    console.error(`  ${chatId}: turn failed:`, e.message))
  queues.set(chatId, next)
  return next
}

function fireFor (chatId) {
  return (sched) => enqueue(chatId, async () => {
    const S = await store.load(chatId)
    if (!S) return
    if (sched.kind === 'step') {
      const r = game.step(S)
      await deliver(chatId, r.emissions, S)
      await store.save(chatId, S)
      if (!r.done) store.schedule(chatId, r.schedule, fireFor(chatId))
    } else if (sched.kind === 'hold') {
      const emissions = game.endHold(S)
      await deliver(chatId, emissions, S)
      await store.save(chatId, S)
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
    if (!S.allWorlds) {                      // re-hydrate after a restart
      const { callModel } = await import('./model.mjs')
      const list = await callModel({ op: 'worlds', readouts: game.READOUTS })
      S.allWorlds = list.worlds
      S.skipped = list.skipped.length
    }
    const r = await game.handle(S, text)
    await deliver(chatId, r.emissions, S)
    store.schedule(chatId, r.schedule, fireFor(chatId))
    store.ensureTimer(chatId, S, fireFor(chatId))
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
  await ctx.answerCallbackQuery().catch(() => {})
  const chatId = String(ctx.chat?.id ?? ctx.from.id)
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
  const why = e?.error_code === 401 || /401/.test(String(e?.description || e))
    ? 'Telegram rejected the token (401 Unauthorized). Check TELEGRAM_BOT_TOKEN ' +
      'in server/.env against what @BotFather gave you.'
    : `Could not reach Telegram: ${e?.description || e?.message || e}`
  console.error(`\n  ${why}\n`)
  process.exit(1)
}

const resumed = await store.resumeAll(fireFor)
const t = timeInfo()
console.log('\n  OFFICE 4B, 6 MACKENZIE WALK - telegram')
console.log(`  model    ${modelInfo().python}`)
console.log(`  time     ${t.scale}x  (a game day is ${describeReal(t.gameDaySeconds)})`)
console.log(`  sessions ${resumed.sessions} saved, ${resumed.resumed} resumed`)
if (ALLOW.length) console.log(`  allow    ${ALLOW.length} user id(s)`)
console.log('  polling...\n')

await bot.start({ onStart: (me) => console.log(`  connected as @${me.username}\n`) })
