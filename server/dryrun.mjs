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
import * as game from './game.mjs'
import { renderTraces, renderGatemap } from './render.mjs'
import { timeInfo, describeReal } from './time.mjs'

const pngDir = process.argv.includes('--png')
  ? process.argv[process.argv.indexOf('--png') + 1] : null
if (pngDir) mkdirSync(pngDir, { recursive: true })

let shot = 0
const sent = { text: 0, photo: 0, bytes: 0 }

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
                                     (_, q) => `q${q}`)
    case 'stake': return ['100G', '250G', '500G', `All ${Math.floor(S.money)}G`]
    case 'market': return ['Buy', 'Sell', 'Leave']
    case 'buy': case 'sell': return ['5', '10', '25', '50']
    default: return null
  }
}

function show (emissions, S) {
  for (const e of emissions) {
    if (e.kind === 'text') {
      sent.text++
      const first = e.text.split('\n')[0].replace(/\*\*/g, '')
      console.log(`  [text ] ${first.slice(0, 88)}`)
    } else {
      const png = e.kind === 'traces'
        ? renderTraces({ n: e.n, z: e.z, upto: e.upto,
            totalReadouts: e.totalReadouts, target: e.target,
            interventionAt: e.interventionAt, title: e.title })
        : renderGatemap({ n: e.n, layers: e.layers, cuts: e.cuts,
            nLayers: e.nLayers, title: e.title })
      sent.photo++; sent.bytes += png.length
      if (pngDir) writeFileSync(join(pngDir, `${String(++shot).padStart(2, '0')}-${e.kind}.png`), png)
      console.log(`  [photo] ${e.kind.padEnd(8)} ${(png.length / 1024 | 0)}KB  ${e.title}`)
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
let step = { done: false }
while (!step.done) { step = game.step(S); show(step.emissions, S) }

console.log(`\n  sent ${sent.text} text and ${sent.photo} photos ` +
            `(${(sent.bytes / 1024 | 0)}KB total)`)
console.log(`  balance ${Math.round(S.money)}G · coherence ${S.coherence.toFixed(3)} ` +
            `· expect '${S.expect}'`)
if (pngDir) console.log(`  images written to ${pngDir}`)
