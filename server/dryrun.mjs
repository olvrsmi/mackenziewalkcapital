// dryrun.mjs - plays a full round with no Telegram at all.
//
// The bot needs a token from @BotFather, so this stands in: it drives the same
// rules, renders the same PNGs and derives the same keyboards, printing what
// would have been sent. Everything except the Bot API itself is exercised.
//
//   node dryrun.mjs              one round, watching then investing
//   node dryrun.mjs --png /tmp   also write every rendered image

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import './env.mjs'
import { loadCopy, holding } from './copy.mjs'
loadCopy({ quiet: true })
import * as game from './game.mjs'
import { renderEmission, RENDERABLE } from './render.mjs'
import { timeInfo, describeReal } from './time.mjs'

const pngDir = process.argv.includes('--png')
  ? process.argv[process.argv.indexOf('--png') + 1] : null
if (pngDir) mkdirSync(pngDir, { recursive: true })

let shot = 0
const sent = { text: 0, photo: 0, captions: 0, unknown: 0, bytes: 0 }

// the same mapping bot.mjs uses, kept in step by importing nothing from it:
// buttons are just the tokens a player could type
function buttonsFor (S) {
  switch (S.expect) {
    case 'world': return [...(S.worlds || []).map((w, i) =>
      `${i + 1}. ${w.name} — ${w.info.n} opportunities`), 'Marketplace']
    case 'invest': return S.readoutIndex === 0
      ? ['Invest', 'Observe', 'Leave'] : ['Invest', 'Observe']
    case 'exit': return ['readout n…', 'the end']
    case 'target': return Array.from({ length: S.world?.info?.n || 0 },
                                     (_, q) => holding(q, S.world?.holdings))
    case 'stake': return ['100G', '250G', '500G', `All ${Math.floor(S.balance)}G`]
    case 'market': return ['Buy', 'Leave']
    case 'buy': return ['1', '2', '5', '10']
    default: return null
  }
}

function show (emissions, S) {
  for (const e of emissions) {
    if (e.kind === 'text') {
      sent.text++
      const first = e.text.split('\n')[0].replace(/\*\*/g, '')
      console.log(`  [text ] ${first.slice(0, 88)}`)
    } else if (RENDERABLE.has(e.kind)) {
      const png = renderEmission(e)
      sent.photo++; sent.bytes += png.length
      if (pngDir) writeFileSync(join(pngDir, `${String(++shot).padStart(2, '0')}-${e.kind}.png`), png)
      console.log(`  [photo] ${e.kind.padEnd(8)} ${(png.length / 1024 | 0)}KB  ${e.title}`)
      if (e.caption) {
        sent.captions++
        for (const line of e.caption.split('\n')) {
          console.log(`  [caption] ${line.replace(/\*\*/g, '')}`)
        }
      }
    } else {
      // The dry run exists to show what a player would get. An emission it
      // cannot draw is exactly the thing worth seeing, not skipping.
      sent.unknown++
      console.log(`  [?????] nothing draws a '${e.kind}' emission`)
    }
  }
  const b = buttonsFor(S)
  if (b) console.log(`  [keys ] ${b.join('  |  ')}`)
}

async function say (S, token) {
  console.log(`\n  > ${token}`)
  const r = await game.handle(S, token)
  show(r.emissions, S)
  return r
}

const t = timeInfo()
console.log(`\n  time scale ${t.scale}x — a game day is ${describeReal(t.gameDaySeconds)}`)
console.log(`  a spent qubit recharges over ${describeReal(1 / game.BASE_REGEN)}\n`)

const S = game.newSession(7)
show((await game.boot(S)).emissions, S)

await say(S, '1')
await say(S, 'o')
await say(S, 'i')
await say(S, '250')
await say(S, '1')
const r = await say(S, '5')
console.log(`\n  (the run would now step every ${game.STEP_MS / 1000}s — ` +
            'releasing them all immediately here)')
// readouts ripen on the game clock, so wind it forward rather than spinning:
// step() reports "nothing due yet" until time has actually passed
let step = { done: false }
let guard = 0
while (!step.done && guard++ < 40) {
  if (S.run) S.run.startedMs -= game.READOUT_GAME_SECONDS * 1000
  step = game.step(S)
  show(step.emissions, S)
}

console.log(`\n  sent ${sent.text} text and ${sent.photo} photos (${sent.captions} carrying a reading) ` +
            `(${(sent.bytes / 1024 | 0)}KB total)`)
console.log(`  balance ${Math.round(S.balance)}G · coherence ${S.coherence.toFixed(3)} ` +
            `· expect '${S.expect}'`)
if (pngDir) console.log(`  images written to ${pngDir}`)
