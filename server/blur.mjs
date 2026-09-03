/**
 * server/blur.mjs - the quantum blur overlay for a chart.
 *
 * A chart is drawn, then a second copy of it is put through a quantum circuit
 * and laid back over the first. What comes back is not a soft focus: the blur
 * is unitary, so instead of averaging a pixel with its neighbours it scatters
 * every part of the image across every other part, and shapes from one corner
 * reappear faintly across the rest. Over a market chart that reads as
 * interference in the instrument rather than a filter on the picture.
 *
 * The steps are Oliver's, worked out by hand in Photoshop, in his order:
 *
 *   1. duplicate the chart
 *   2. downscale the copy to `size` px on its longest side
 *   3. threshold it at `threshold` - a hard black-and-white cut
 *   4. send that through Moth's blur-v2 engine
 *   5. scale the result back to full size, nearest-neighbour, so the blur
 *      keeps the blocky edge the small canvas gave it
 *   6. lay it over the original in `blend` mode
 *
 * Order matters at 2 and 3. Downscaling first and thresholding second means
 * the cut lands on already-averaged pixels, which is what makes the threshold
 * level so sensitive: the chart's gridlines are #202020, luminance 32, so they
 * survive a threshold of 28 and vanish at 33. Reversing the two steps would
 * lose that, and lose the tuning along with it.
 *
 * Every knob is here rather than in the caller because tools/ tunes them
 * against this file: what the page adjusts is what the box will run.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFileSync } from 'node:fs'

const API = 'https://api.mothquantum.com'
const ENGINE = 'blur-v2'

export const DEFAULTS = {
  // the pipeline
  size: 128,              // longest side of the downscaled copy, px
  threshold: 28,          // Photoshop's Threshold level, 1-255
  blend: 'vivid-light',
  opacity: 1,             // layer opacity of the overlay, 0-1
  // Not part of the Photoshop process, and 1 does nothing, so the defaults
  // still reproduce it exactly. It is here because of what the numbers say: a
  // chart is about 95% background, so a thresholded copy is only about 5%
  // white, and the blur is unitary - it conserves intensity rather than
  // adding any, so spreading that 5% across the whole canvas leaves almost
  // nothing above 0.5. Vivid light burns everything below 0.5 toward black,
  // so the overlay has to be lifted before it can do anything but darken.
  gain: 1,                // multiplier on the overlay, before blending

  // blur-v2's own params
  strength: 0.7,          // 0 leaves the image alone, 1 is maximum blur
  style: 'rx',            // rx or ry: the gate the rotation uses
  reach: 0,               // 0 fully local, 1 fully non-local
  engineSize: 1024,       // pixel budget per pass; ours is smaller than this
  downscaleRegions: true, // engine-side strategy for regions over budget

  // what gets sent up the wire
  format: 'png',          // png or jpeg - the engine answers in kind
  quality: 0.92,          // jpeg only
}

// ---------------------------------------------------------------------------
// Blend modes
// ---------------------------------------------------------------------------

// Photoshop's separable blend modes, on gamma-encoded channels in 0..1 - which
// is what Photoshop itself does, so no linearisation. `a` is the backdrop (the
// chart), `b` is the layer over it (the blur).
//
// Vivid light is the one this pipeline was built around and the one canvas
// cannot do: globalCompositeOperation has no vivid-light, linear-light,
// pin-light or linear-dodge. Rather than getting some modes from skia and
// others from here, all of them are here - one set of formulas, identical
// wherever this runs.
// Photoshop's luminosity weights, which is what its Threshold cuts on - not a
// channel average, and not Rec.709. Exported so a tuning page can say where a
// colour sits relative to the cut using the same arithmetic the cut uses.
export const LUMA_WEIGHTS = [0.3, 0.59, 0.11]
export const lumaOf = (r, g, b) =>
  LUMA_WEIGHTS[0] * r + LUMA_WEIGHTS[1] * g + LUMA_WEIGHTS[2] * b
export const lumaOfHex = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return lumaOf((n >> 16) & 255, (n >> 8) & 255, n & 255)
}

const burn = (a, b) => (b <= 0 ? 0 : 1 - Math.min(1, (1 - a) / b))
const dodge = (a, b) => (b >= 1 ? 1 : Math.min(1, a / (1 - b)))
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

export const BLEND_MODES = {
  'normal': (a, b) => b,
  'multiply': (a, b) => a * b,
  'screen': (a, b) => a + b - a * b,
  'overlay': (a, b) => (a <= 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)),
  'darken': (a, b) => Math.min(a, b),
  'lighten': (a, b) => Math.max(a, b),
  'color-dodge': dodge,
  'color-burn': burn,
  'linear-dodge': (a, b) => clamp01(a + b),
  'linear-burn': (a, b) => clamp01(a + b - 1),
  'hard-light': (a, b) => (b <= 0.5 ? a * (2 * b) : 1 - (1 - a) * (2 - 2 * b)),
  // Photoshop's soft light, the one with the cube-root-ish D(a) - not the
  // simpler w3c formula, which is visibly flatter in the shadows.
  'soft-light': (a, b) => {
    if (b <= 0.5) return a - (1 - 2 * b) * a * (1 - a)
    const d = a <= 0.25 ? ((16 * a - 12) * a + 4) * a : Math.sqrt(a)
    return a + (2 * b - 1) * (d - a)
  },
  // colour burn below the midpoint, colour dodge above it. Continuous at 0.5,
  // where both reduce to a.
  'vivid-light': (a, b) => (b <= 0.5 ? burn(a, 2 * b) : dodge(a, 2 * b - 1)),
  'linear-light': (a, b) => clamp01(a + 2 * b - 1),
  'pin-light': (a, b) => (b <= 0.5 ? Math.min(a, 2 * b) : Math.max(a, 2 * b - 1)),
  'hard-mix': (a, b) => ((b <= 0.5 ? burn(a, 2 * b) : dodge(a, 2 * b - 1)) < 0.5 ? 0 : 1),
  'difference': (a, b) => Math.abs(a - b),
  'exclusion': (a, b) => a + b - 2 * a * b,
}

export const blendNames = () => Object.keys(BLEND_MODES)

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

const canvasOf = (w, h) => {
  const c = createCanvas(w, h)
  return { canvas: c, ctx: c.getContext('2d') }
}

/** The copy, downscaled so its longest side is `size`. */
export function downscale (image, size) {
  const scale = size / Math.max(image.width, image.height)
  const w = Math.max(1, Math.round(image.width * scale))
  const h = Math.max(1, Math.round(image.height * scale))
  const { canvas, ctx } = canvasOf(w, h)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, w, h)
  return canvas
}

/**
 * Photoshop's Threshold: everything at or above `level` goes white, everything
 * below goes black, on luminosity rather than a channel average. Alpha is
 * forced opaque - blur-v2 reads the alpha channel as its mask when no mask is
 * given, so a transparent pixel here would quietly be left unblurred.
 */
export function threshold (canvas, level) {
  const ctx = canvas.getContext('2d')
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const luma = lumaOf(d[i], d[i + 1], d[i + 2])
    const v = luma >= level ? 255 : 0
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

/**
 * Back up to full size, nearest-neighbour. Written out rather than left to
 * `imageSmoothingEnabled = false`, because what that flag does to a 10x
 * upscale is skia's business and this needs to be the same on every machine -
 * and because the hard pixel edge is the point, not an artefact to be
 * tolerated.
 */
export function nearest (image, w, h) {
  const { canvas, ctx } = canvasOf(image.width, image.height)
  ctx.drawImage(image, 0, 0)
  const src = ctx.getImageData(0, 0, image.width, image.height).data
  const out = canvasOf(w, h)
  const dst = out.ctx.createImageData(w, h)
  const xs = new Uint32Array(w)
  for (let x = 0; x < w; x++) xs[x] = Math.min(image.width - 1, (x * image.width / w) | 0)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(image.height - 1, (y * image.height / h) | 0)
    const srow = sy * image.width * 4
    const drow = y * w * 4
    for (let x = 0; x < w; x++) {
      const s = srow + xs[x] * 4
      const t = drow + x * 4
      dst.data[t] = src[s]
      dst.data[t + 1] = src[s + 1]
      dst.data[t + 2] = src[s + 2]
      dst.data[t + 3] = src[s + 3]
    }
  }
  out.ctx.putImageData(dst, 0, 0)
  return out.canvas
}

/** The overlay, laid over the chart in `mode` at `opacity`. */
export function composite (base, top, mode, opacity = 1) {
  const fn = BLEND_MODES[mode]
  if (!fn) throw new Error(`unknown blend mode "${mode}"`)
  const { canvas, ctx } = canvasOf(base.width, base.height)
  ctx.drawImage(base, 0, 0)
  const out = ctx.getImageData(0, 0, base.width, base.height)

  const t = canvasOf(base.width, base.height)
  t.ctx.drawImage(top, 0, 0, base.width, base.height)
  const over = t.ctx.getImageData(0, 0, base.width, base.height).data

  const d = out.data
  for (let i = 0; i < d.length; i += 4) {
    // The layer's own alpha times the layer opacity, so a blur that came back
    // with transparency does not blend as if it were black.
    const w = (over[i + 3] / 255) * opacity
    if (w <= 0) continue
    for (let c = 0; c < 3; c++) {
      const a = d[i + c] / 255
      const v = fn(a, over[i + c] / 255)
      d[i + c] = Math.round(255 * (a + (clamp01(v) - a) * w))
    }
  }
  ctx.putImageData(out, 0, 0)
  return canvas
}

/** The overlay, brightened. A no-op at 1. */
export function gainUp (canvas, gain) {
  if (gain === 1) return canvas
  const ctx = canvas.getContext('2d')
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, d[i] * gain)
    d[i + 1] = Math.min(255, d[i + 1] * gain)
    d[i + 2] = Math.min(255, d[i + 2] * gain)
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

/**
 * What a layer will do to a blend, before it does it.
 *
 * `dodges` is the share of pixels above the midpoint - the ones vivid light
 * brightens. Everything else it burns. On a chart that number starts near
 * zero, which is the single most useful thing to know while tuning: a
 * threshold or a gain that does not move it is not going to change the look.
 */
export function layerStats (canvas) {
  const ctx = canvas.getContext('2d')
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let sum = 0, max = 0, dodges = 0, white = 0
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    const l = lumaOf(d[i], d[i + 1], d[i + 2])
    sum += l
    if (l > max) max = l
    if (l >= 127.5) dodges += 1
    if (l > 250) white += 1
  }
  return {
    mean: Math.round((sum / n) * 10) / 10,
    max: Math.round(max),
    dodges: Math.round((1000 * dodges) / n) / 10,
    white: Math.round((1000 * white) / n) / 10,
  }
}

const encode = (canvas, format, quality) =>
  format === 'jpeg' ? canvas.toBuffer('image/jpeg', Math.round(quality * 100))
                    : canvas.toBuffer('image/png')

// ---------------------------------------------------------------------------
// blur-v2
// ---------------------------------------------------------------------------

let cachedKey = null
/**
 * The Moth API key. Never logged, and never handed to the browser: the tuning
 * page talks to localhost and localhost talks to Moth.
 */
export function mothKey () {
  if (cachedKey) return cachedKey
  if (process.env.MW_MOTH_KEY) return (cachedKey = process.env.MW_MOTH_KEY.trim())
  const path = process.env.MW_MOTH_KEY_FILE
  if (!path) throw new Error('no Moth API key: set MW_MOTH_KEY or MW_MOTH_KEY_FILE')
  return (cachedKey = readFileSync(path, 'utf8').trim())
}

async function api (path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${mothKey()}`, ...(init.headers || {}) },
  })
  const text = await res.text()
  let body = text
  try { body = text ? JSON.parse(text) : null } catch {}
  if (typeof body === 'string' && /^\s*<(!doctype|html)/i.test(body)) {
    body = { gateway_error: (body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || 'HTML error' }
  }
  if (!res.ok) {
    const detail = (body && (body.detail || body.title || body.gateway_error)) ||
      String(body).slice(0, 300)
    throw Object.assign(new Error(`${res.status} ${path}: ${detail}`), { status: res.status, body })
  }
  return body
}

/**
 * One image through blur-v2, with the wall clock split by hop.
 *
 * There is no single roundtrip to measure. An engine run is four exchanges -
 * register an asset, PUT the bytes to the signed url, submit the job, poll
 * until it finishes, fetch the result - so a lump total hides which part a
 * change actually moved. `timings` keeps them apart, in ms.
 */
export async function blurWithMoth (bytes, contentType, params) {
  const timings = {}
  const clock = async (name, fn) => {
    const t0 = performance.now()
    try { return await fn() } finally { timings[name] = Math.round(performance.now() - t0) }
  }

  const created = await clock('asset', async () => {
    const c = await api('/api/v1/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: contentType === 'image/jpeg' ? 'chart.jpg' : 'chart.png',
        content_type: contentType,
        size_bytes: bytes.length,
      }),
    })
    // Content type and length are signed into the url: send its headers verbatim.
    const put = await fetch(c.upload.url,
      { method: c.upload.method || 'PUT', headers: c.upload.headers, body: bytes })
    if (!put.ok) throw new Error(`upload PUT ${put.status}: ${(await put.text()).slice(0, 200)}`)
    await api(`/api/v1/assets/${c.asset_id}/complete`, { method: 'POST' })
    return c
  })

  const job = await clock('submit', () => api(`/api/v1/engines/${ENGINE}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params, input_files: { image: created.asset_id } }),
  }))

  let polls = 0
  const status = await clock('run', async () => {
    // Tight at first, easing off: a small image comes back in well under a
    // second and a coarse interval would report the interval, not the engine.
    for (let wait = 100; ; wait = Math.min(1000, Math.round(wait * 1.4))) {
      const s = await api(`/api/v1/jobs/${job.job_id}/status`)
      polls += 1
      if (s.status === 'completed') return s
      if (s.status === 'failed' || s.status === 'cancelled') {
        throw new Error(`blur ${s.status}: ${JSON.stringify(s.error || s).slice(0, 300)}`)
      }
      await new Promise((r) => setTimeout(r, wait))
    }
  })

  const out = await clock('download', async () => {
    const result = await api(`/api/v1/jobs/${job.job_id}/result`)
    const file = (result.outputs || []).find((o) => o.url)
    if (!file) throw new Error(`blur returned no file: ${JSON.stringify(result).slice(0, 200)}`)
    const res = await fetch(file.url)
    if (!res.ok) throw new Error(`result download ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  })

  timings.total = Object.values(timings).reduce((a, b) => a + b, 0)
  return { bytes: out, timings, polls, jobId: job.job_id, status: status.status }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * A chart in, the same chart with the blur laid over it out.
 *
 * `keep` collects each intermediate as a PNG so a tuning page can show the
 * working; production leaves it off and only the last one is encoded.
 *
 * `blurred` short-circuits step 4. Blend mode and opacity are the two knobs
 * worth twiddling fastest and the only two downstream of the engine, so a
 * caller that already has a blur for these upstream settings can pass it back
 * in and pay nothing.
 */
export async function blurChart (png, opts = {}, { keep = false, blurred = null } = {}) {
  const o = { ...DEFAULTS, ...opts }
  const stages = {}
  const timings = {}
  const clock = async (name, fn) => {
    const t0 = performance.now()
    try { return await fn() } finally { timings[name] = Math.round(performance.now() - t0) }
  }

  const base = await loadImage(png)
  const small = await clock('downscale', async () => downscale(base, o.size))
  const cut = await clock('threshold', async () => threshold(small, o.threshold))
  if (keep) stages.threshold = cut.toBuffer('image/png')

  const contentType = o.format === 'jpeg' ? 'image/jpeg' : 'image/png'
  let api_ = null
  if (!blurred) {
    const payload = encode(cut, o.format, o.quality)
    timings.upload_bytes = payload.length
    api_ = await clock('blur', () => blurWithMoth(payload, contentType, {
      strength: o.strength,
      style: o.style,
      reach: o.reach,
      size: o.engineSize,
      downscale: o.downscaleRegions,
    }))
    blurred = api_.bytes
  }
  if (keep) stages.blurred = blurred

  const blurImg = await loadImage(blurred)
  const up = await clock('upscale', async () =>
    gainUp(nearest(blurImg, base.width, base.height), o.gain))
  if (keep) stages.upscaled = up.toBuffer('image/png')

  const out = await clock('composite', async () => composite(base, up, o.blend, o.opacity))
  const result = await clock('encode', async () => out.toBuffer('image/png'))

  const stats = keep ? { threshold: layerStats(cut), overlay: layerStats(up) } : null

  return {
    png: result,
    stages,
    stats,
    timings: { ...timings, api: api_ ? api_.timings : null },
    blurred,
    width: base.width,
    height: base.height,
    small: { width: small.width, height: small.height },
    job: api_ ? { id: api_.jobId, polls: api_.polls } : null,
    settings: o,
  }
}
