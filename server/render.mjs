// render.mjs - the visuals, drawn server-side and handed to Telegram as PNGs.
//
// A port of the canvas drawing from the browser prototype's client. The bot has
// no client to draw in, so the same 2D-context code runs here against
// @napi-rs/canvas and the result is uploaded.
//
// Colours are the vim-bloomberg palette - the terminal's own amber over a set of
// saturated hues that stay apart from each other at phone size. Amber is
// reserved: it is the chrome and the holding you are actually in, never an
// ordinary series, so the thing you hold is the only amber line on a screen that
// is otherwise amber-framed.
//
// Keep captions to ASCII: the bundled font has no mathematical angle brackets
// (U+27E8/27E9) or box-drawing glyphs, and renders them as tofu.

import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { t, holding } from './copy.mjs'

// Vendored rather than left to the host: a box with no Roboto would silently
// fall back to whatever it does have, and the chart would be a different chart
// there than the one that was designed here. Both are SIL Open Font License.
const FONTS = join(dirname(fileURLToPath(import.meta.url)), 'fonts')
for (const file of ['RobotoCondensed[wght].ttf', 'RobotoMono[wght].ttf']) {
  try {
    GlobalFonts.registerFromPath(join(FONTS, file))
  } catch {
    // A missing font is a worse-looking chart, not a dead bot.
    console.warn(`  render: could not load ${file}; falling back to a system font`)
  }
}

const BG = '#000000'
const INK = '#F6F3E8'      // values and labels: the palette's off-white
const DIM = '#909090'      // axis annotation
const LINE = '#202020'     // baselines and rules
const AMBER = '#F39000'    // the terminal's own: chrome, and the held holding

// Seven, because a world runs to seven holdings, and chosen to stay apart from
// each other AND from amber, which is spoken for.
const QCOL = ['#FF6C60', '#A8FF60', '#96CBFE', '#FF73FD',
              '#E0C010', '#00A0A0', '#C6C5FE', '#E18964',
              '#0B85DF', '#B18A3D']
const qcol = (q) => QCOL[q % QCOL.length]

// Roboto Mono for every number and chart label, so figures line up in columns;
// Roboto Condensed for the header, which has to fit a world's name at 640px.
const MONO = '"Roboto Mono", "Courier New", monospace'
const SANS = '"Roboto Condensed", Arial, sans-serif'

// Telegram scales photos to the chat width, so render at 2x for a crisp result
const SCALE = 2
const WIDTH = 640

function frame (height, title, draw) {
  const canvas = createCanvas(WIDTH * SCALE, height * SCALE)
  const ctx = canvas.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, WIDTH, height)
  ctx.fillStyle = AMBER
  ctx.font = `bold 13px ${SANS}`
  ctx.textAlign = 'left'
  ctx.fillText(title.toUpperCase(), 14, 22)
  ctx.strokeStyle = AMBER
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, 32)
  ctx.lineTo(WIDTH, 32)
  ctx.stroke()
  draw(ctx, WIDTH, height)
  return canvas.toBuffer('image/png')
}

/**
 * <Z> for every circuit qubit across the readouts seen so far.
 * `target` and `interventionAt` are null before an investment is placed.
 */
export function renderTraces ({ n, z, priced, upto, totalReadouts, target = null,
                                interventionAt = null, holdings, title }) {
  const H = 48 + n * 26 + 30
  return frame(H, title, (ctx, W) => {
    const padL = 52, padR = 66, padT = 48
    const plotW = W - padL - padR
    const total = Math.max(1, totalReadouts - 1)
    const x = (k) => padL + (k / total) * plotW

    if (interventionAt !== null) {
      ctx.fillStyle = 'rgba(243,144,0,.10)'
      ctx.fillRect(x(interventionAt), padT - 8,
                   x(total) - x(interventionAt), n * 26 + 10)
      ctx.strokeStyle = AMBER
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x(interventionAt), padT - 8)
      ctx.lineTo(x(interventionAt), padT + n * 26 + 2)
      ctx.stroke()
      ctx.setLineDash([])
    }

    for (let q = 0; q < n; q++) {
      const yMid = padT + q * 26 + 11
      const amp = 9
      const isTarget = q === target

      ctx.strokeStyle = LINE
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL, yMid)
      ctx.lineTo(padL + plotW, yMid)
      ctx.stroke()

      ctx.fillStyle = isTarget ? AMBER : DIM
      ctx.font = `${isTarget ? 'bold ' : ''}12px ${MONO}`
      ctx.textAlign = 'right'
      ctx.fillText(holding(q, holdings), padL - 10, yMid + 4)

      // Each holding is drawn against its OWN range, because quotes differ by an
      // order of magnitude across a world and a shared linear axis flattens the
      // cheap ones to a straight line. A shared log axis is the better answer
      // and belongs with the square-plot work; this keeps every holding legible
      // until then.
      const raw = (priced || z).map((row) => row[q])
      const lo = Math.min(...raw), hi = Math.max(...raw)
      const mid = (lo + hi) / 2
      const half = Math.max((hi - lo) / 2, Math.abs(mid) * 1e-6, 1e-9)
      const series = raw.map((v) => (v - mid) / half)
      ctx.strokeStyle = qcol(q)
      ctx.lineWidth = isTarget ? 2.6 : 1.6
      ctx.beginPath()
      series.forEach((v, k) => {
        const px = x(k), py = yMid - v * amp
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)
      })
      ctx.stroke()
      ctx.fillStyle = qcol(q)
      series.forEach((v, k) => {
        ctx.beginPath()
        ctx.arc(x(k), yMid - v * amp, isTarget ? 2.8 : 2, 0, Math.PI * 2)
        ctx.fill()
      })

      // the number beside the line is the quote itself, not a normalised one
      const now = raw[raw.length - 1]
      ctx.fillStyle = isTarget ? AMBER : INK
      ctx.textAlign = 'left'
      ctx.font = `${isTarget ? 'bold ' : ''}12px ${MONO}`
      ctx.fillText(priced ? Math.round(now).toLocaleString('en-GB')
                          : `${now >= 0 ? '+' : ''}${now.toFixed(3)}`,
                   padL + plotW + 10, yMid + 4)
    }

    ctx.fillStyle = DIM
    ctx.font = `11px ${MONO}`
    ctx.textAlign = 'left'
    ctx.fillText('readout 0', padL, padT + n * 26 + 18)
    ctx.textAlign = 'right'
    ctx.fillText(`${total}  .  ${t('plots.traces_legend')}`,
                 padL + plotW, padT + n * 26 + 18)
  })
}

/**
 * The one place an emission becomes a picture.
 *
 * Two callers draw plots - the bot and the dry run - and each used to spell out
 * the same argument lists. A field added to a plot had to be added in both, and
 * a plot changed in one drifted silently from the other. Worse, the dry run's
 * dispatch was an if/else on 'traces': anything that was not a traces emission
 * was handed to the gate-map renderer, so an unrecognised kind came out as
 * the wrong picture rather than as an error.
 *
 * RENDERABLE lets a caller ask "is this mine to draw?" without repeating the
 * list, so an emission kind nobody draws is loud instead of lost.
 */
export const RENDERABLE = new Set(['traces'])

export function renderEmission (e) {
  switch (e.kind) {
    case 'traces':
      return renderTraces({
        n: e.n, z: e.z, priced: e.priced, upto: e.upto,
        totalReadouts: e.totalReadouts,
        target: e.target, interventionAt: e.interventionAt,
        holdings: e.holdings, title: e.title,
      })
    default:
      throw new Error(`renderEmission: nothing draws a '${e.kind}' emission`)
  }
}
