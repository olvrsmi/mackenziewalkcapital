// render.mjs - the visuals, drawn server-side and handed to Telegram as PNGs.
//
// A port of the canvas drawing from the browser prototype's client. The bot has
// no client to draw in, so the same 2D-context code runs here against
// @napi-rs/canvas and the result is uploaded. Colours are the harsh saturated
// set on black: ZX Spectrum brights read at phone size in a way that a muted
// palette does not.
//
// Keep captions to ASCII: the bundled font has no mathematical angle brackets
// (U+27E8/27E9) or box-drawing glyphs, and renders them as tofu.

import { createCanvas } from '@napi-rs/canvas'

import { t, holding } from './copy.mjs'

const INK = '#FFFFFF'      // labels and values
const DIM = '#AAAAAA'      // axis annotation
const LINE = '#444444'     // baselines and rules
const ACCENT = '#00FFFF'   // two-qubit gates
const ONEQ = '#FF00FF'     // one-qubit gates
const WARM = '#FFFF00'     // the target, and the intervention marker
const BG = '#000000'

const QCOL = ['#FF0000', '#00FF00', '#0000FF', '#FF00FF', '#00FFFF',
              '#FFFF00', '#FFFFFF', '#FF8000', '#8000FF', '#00FF80']
const qcol = (q) => QCOL[q % QCOL.length]

const MONO = '"Courier New", Courier, monospace'
const SANS = 'Arial, Helvetica, sans-serif'

// Telegram scales photos to the chat width, so render at 2x for a crisp result
const SCALE = 2
const WIDTH = 640

function frame (height, title, draw) {
  const canvas = createCanvas(WIDTH * SCALE, height * SCALE)
  const ctx = canvas.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, WIDTH, height)
  ctx.fillStyle = INK
  ctx.font = `bold 12px ${SANS}`
  ctx.textAlign = 'left'
  ctx.fillText(title.toUpperCase(), 14, 22)
  ctx.strokeStyle = INK
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
export function renderTraces ({ n, z, upto, totalReadouts, target = null,
                                interventionAt = null, holdings, title }) {
  const H = 48 + n * 26 + 30
  return frame(H, title, (ctx, W) => {
    const padL = 52, padR = 66, padT = 48
    const plotW = W - padL - padR
    const total = Math.max(1, totalReadouts - 1)
    const x = (k) => padL + (k / total) * plotW

    if (interventionAt !== null) {
      ctx.fillStyle = 'rgba(255,255,0,.10)'
      ctx.fillRect(x(interventionAt), padT - 8,
                   x(total) - x(interventionAt), n * 26 + 10)
      ctx.strokeStyle = WARM
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

      ctx.fillStyle = isTarget ? WARM : DIM
      ctx.font = `${isTarget ? 'bold ' : ''}12px ${MONO}`
      ctx.textAlign = 'right'
      ctx.fillText(holding(q, holdings), padL - 10, yMid + 4)

      const series = z.map((row) => row[q])
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

      const now = series[series.length - 1]
      ctx.fillStyle = isTarget ? WARM : INK
      ctx.textAlign = 'left'
      ctx.font = `${isTarget ? 'bold ' : ''}12px ${MONO}`
      ctx.fillText(`${now >= 0 ? '+' : ''}${now.toFixed(3)}`,
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
 * One column per DAG layer: squares for single-qubit gates, joined dots for
 * two-qubit, dashes for the readout cuts. Legible at any depth, unlike a real
 * gate diagram, and its x axis *is* the layer index so the cuts land exactly.
 */
export function renderGatemap ({ n, layers, cuts, nLayers, holdings, title }) {
  const H = 48 + n * 18 + 30
  return frame(H, title, (ctx, W) => {
    const padL = 52, padR = 18, padT = 48
    const plotW = W - padL - padR
    const D = Math.max(1, nLayers)
    const x = (l) => padL + (l / D) * plotW
    const y = (q) => padT + q * 18

    for (let q = 0; q < n; q++) {
      ctx.strokeStyle = LINE
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL, y(q))
      ctx.lineTo(padL + plotW, y(q))
      ctx.stroke()
      ctx.fillStyle = DIM
      ctx.font = `11px ${MONO}`
      ctx.textAlign = 'right'
      ctx.fillText(holding(q, holdings), padL - 10, y(q) + 4)
    }

    ctx.strokeStyle = 'rgba(255,255,255,.35)'
    ctx.setLineDash([2, 3])
    for (const c of cuts) {
      ctx.beginPath()
      ctx.moveTo(x(c), padT - 8)
      ctx.lineTo(x(c), y(n - 1) + 8)
      ctx.stroke()
    }
    ctx.setLineDash([])

    const dense = D > 160
    layers.forEach((layer, li) => {
      for (const qs of layer) {
        if (qs.length === 2) {
          const a = Math.min(...qs), b = Math.max(...qs)
          ctx.strokeStyle = ACCENT
          ctx.globalAlpha = dense ? 0.55 : 0.9
          ctx.lineWidth = dense ? 0.8 : 1.2
          ctx.beginPath()
          ctx.moveTo(x(li), y(a))
          ctx.lineTo(x(li), y(b))
          ctx.stroke()
          ctx.globalAlpha = 1
          ctx.fillStyle = ACCENT
          for (const q of [a, b]) {
            ctx.beginPath()
            ctx.arc(x(li), y(q), dense ? 1.2 : 2, 0, Math.PI * 2)
            ctx.fill()
          }
        } else if (qs.length === 1) {
          ctx.fillStyle = ONEQ
          const s = dense ? 1.6 : 2.8
          ctx.fillRect(x(li) - s / 2, y(qs[0]) - s / 2, s, s)
        }
      }
    })

    ctx.fillStyle = DIM
    ctx.font = `11px ${MONO}`
    ctx.textAlign = 'left'
    ctx.fillText('layer 0', padL, y(n - 1) + 22)
    ctx.textAlign = 'right'
    ctx.fillText(`${D}  .  ${t('plots.gatemap_legend')}`,
                 padL + plotW, y(n - 1) + 22)
  })
}
