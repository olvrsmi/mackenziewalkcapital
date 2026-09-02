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
// square, as a market chart is - the row-per-holding letterbox is gone
const SQUARE = 620

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
 * Every holding's quote, on one shared logarithmic axis.
 *
 * Shared, because a market is a market: holdings have to be comparable, and a
 * row apiece said nothing about which was dearer. Logarithmic, because within
 * one world quotes run from about 100G to about 3,000G, and on a linear axis the
 * cheap ones flatten to a straight line while the dear ones use the whole frame.
 * On a log axis a 2% move is the same height wherever it happens, which is both
 * what a market chart does and the only way seven holdings share a frame legibly.
 *
 * `priced` is the quote series. `z` is the raw reading, kept as a fallback for
 * any caller that has not been through the pricing - readings can be negative,
 * so that path stays linear.
 */
export function renderTraces ({ n, z, priced, upto, totalReadouts, target = null,
                                interventionAt = null, holdings, title }) {
  const series = priced || z
  const log = Boolean(priced)
  return frame(SQUARE, title, (ctx, W) => {
    const padL = 54, padR = 92, padT = 50, padB = 40
    const plotW = W - padL - padR
    const plotH = SQUARE - padT - padB
    const total = Math.max(1, totalReadouts - 1)
    const x = (k) => padL + (k / total) * plotW

    const flat = series.flat().filter((v) => Number.isFinite(v))
    let lo = Math.min(...flat), hi = Math.max(...flat)
    if (log) { lo /= 1.08; hi *= 1.08 } else { lo = Math.min(lo, -1); hi = Math.max(hi, 1) }
    if (!(hi > lo)) { hi = lo + 1 }
    const y = log
      ? (v) => padT + plotH - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * plotH
      : (v) => padT + plotH - (v - lo) / (hi - lo) * plotH

    // --- the frame ----------------------------------------------------------
    ctx.font = `11px ${MONO}`
    ctx.textAlign = 'right'
    for (const v of log ? logTicks(lo, hi) : [-1, 0, 1]) {
      ctx.strokeStyle = LINE
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL, y(v))
      ctx.lineTo(padL + plotW, y(v))
      ctx.stroke()
      ctx.fillStyle = DIM
      ctx.fillText(log ? Math.round(v).toLocaleString('en-GB') : v.toFixed(0),
                   padL - 8, y(v) + 4)
    }

    // where the coupling was made, and everything after it
    if (interventionAt !== null) {
      ctx.fillStyle = 'rgba(243,144,0,.08)'
      ctx.fillRect(x(interventionAt), padT, x(total) - x(interventionAt), plotH)
      ctx.strokeStyle = AMBER
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x(interventionAt), padT)
      ctx.lineTo(x(interventionAt), padT + plotH)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // --- the holdings -------------------------------------------------------
    // drawn with the held one last, so it is never buried under another line
    const order = [...Array(n).keys()].sort((a, b) => (a === target) - (b === target))
    for (const q of order) {
      const isTarget = q === target
      const line = series.map((row) => row[q])
      ctx.strokeStyle = isTarget ? AMBER : qcol(q)
      ctx.lineWidth = isTarget ? 3 : 1.6
      ctx.globalAlpha = isTarget ? 1 : 0.9
      ctx.beginPath()
      line.forEach((v, k) => (k ? ctx.lineTo(x(k), y(v)) : ctx.moveTo(x(k), y(v))))
      ctx.stroke()
      ctx.fillStyle = isTarget ? AMBER : qcol(q)
      line.forEach((v, k) => {
        ctx.beginPath()
        ctx.arc(x(k), y(v), isTarget ? 3 : 2, 0, Math.PI * 2)
        ctx.fill()
      })
      ctx.globalAlpha = 1
    }

    // --- the labels ---------------------------------------------------------
    // At the right edge, at each line's last value - but seven holdings can sit
    // within a few pixels of one another, so they are pushed apart into reading
    // order rather than allowed to overprint.
    const labels = order.map((q) => ({
      q,
      at: y(series[series.length - 1][q]),
      text: log ? Math.round(series[series.length - 1][q]).toLocaleString('en-GB')
                : series[series.length - 1][q].toFixed(3),
    })).sort((a, b) => a.at - b.at)
    spread(labels, 15, padT + 6, padT + plotH - 6)

    for (const l of labels) {
      const isTarget = l.q === target
      ctx.font = `${isTarget ? 'bold ' : ''}12px ${MONO}`
      ctx.textAlign = 'left'
      ctx.fillStyle = isTarget ? AMBER : qcol(l.q)
      ctx.fillText(holding(l.q, holdings), padL + plotW + 8, l.y + 4)
      ctx.fillStyle = isTarget ? AMBER : INK
      ctx.textAlign = 'right'
      ctx.fillText(l.text, W - 8, l.y + 4)
    }

    // --- the foot -----------------------------------------------------------
    ctx.fillStyle = DIM
    ctx.font = `11px ${MONO}`
    ctx.textAlign = 'left'
    ctx.fillText(t('vocabulary.moment', { index: 0 }), padL, SQUARE - 16)
    ctx.textAlign = 'right'
    ctx.fillText(`${t('vocabulary.moment', { index: total })}  .  ` +
                 `${t('plots.traces_legend')}`, padL + plotW, SQUARE - 16)
  })
}

/**
 * Gridline values inside [lo, hi], on a 1/2/5-style ladder.
 *
 * Thinned when there are too many, but never allowed to come back empty: a
 * two-holding world can span 250G to 380G, which crosses no round number that a
 * coarse ladder knows about, and a frame with no gridlines at all is worse than
 * one with slightly odd ones.
 */
function logTicks (lo, hi, most = 7) {
  const ladder = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]
  const all = []
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of ladder) {
      const v = m * Math.pow(10, e)
      if (v >= lo && v <= hi) all.push(v)
    }
  }
  all.sort((a, b) => a - b)
  if (!all.length) {
    // nothing round in range: three of our own, spaced on the log axis
    const g = (f) => Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * f)
    return [g(0.15), g(0.5), g(0.85)].map((v) => Math.round(v))
  }
  if (all.length <= most) return all
  const step = Math.ceil(all.length / most)
  return all.filter((_, i) => i % step === 0)
}

/**
 * Push a sorted list of {at} apart so no two are closer than `gap`, keeping them
 * inside [min, max]. Writes `.y`. A simple forward pass then a backward one:
 * enough for seven labels, and it never reorders them.
 */
function spread (items, gap, min, max) {
  items.forEach((it) => { it.y = it.at })
  for (let i = 1; i < items.length; i++) {
    if (items[i].y - items[i - 1].y < gap) items[i].y = items[i - 1].y + gap
  }
  if (items.length && items[items.length - 1].y > max) {
    items[items.length - 1].y = max
    for (let i = items.length - 2; i >= 0; i--) {
      if (items[i + 1].y - items[i].y < gap) items[i].y = items[i + 1].y - gap
    }
  }
  items.forEach((it) => { it.y = Math.max(min, Math.min(max, it.y)) })
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
