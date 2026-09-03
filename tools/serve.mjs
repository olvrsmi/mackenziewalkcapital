/**
 * tools/serve.mjs - a bench for tuning the chart blur.
 *
 * Localhost only, and the API key never leaves it: the page posts settings
 * here, this posts images to Moth, and the browser only ever sees pictures and
 * milliseconds.
 *
 *     MW_MOTH_KEY_FILE=../../moth-api/KEY node tools/serve.mjs
 *     open http://localhost:5060
 *
 * The pipeline itself is ../server/blur.mjs - the same module the bot will
 * call - so a setting that looks right here is a setting that works on the
 * box. Nothing about the effect is implemented in this file or in the page.
 *
 * WHAT IT DRAWS ON
 * ----------------
 * fixture.json: a real ten-step run of spec_n7_01, the widest world there is
 * at seven holdings, with a coupling at step 4. Real rather than invented,
 * because a threshold has to be judged against the picture the game actually
 * makes - lines that cross, labels pushed apart, a dashed counterfactual
 * behind the held line, the amber band after the coupling, and #202020
 * gridlines that sit within a few levels of the default cut.
 *
 * Regenerate it with tools/fixture.mjs if the chart's design changes.
 *
 * WHAT COSTS A CREDIT
 * -------------------
 * The engine, once per run. Blend mode and opacity are downstream of it, so
 * the last blur is kept and those two recomposite locally for nothing - which
 * is why they update as you drag and everything else waits for the button.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadCopy, list } from '../server/copy.mjs'
import { renderEmission, PALETTE } from '../server/render.mjs'
import { basePrice, quote } from '../server/game.mjs'
import { blurChart, DEFAULTS, blendNames, lumaOfHex } from '../server/blur.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 5060)

if (!process.env.MW_MOTH_KEY && !process.env.MW_MOTH_KEY_FILE) {
  process.env.MW_MOTH_KEY_FILE = join(HERE, '..', '..', 'moth-api', 'KEY')
}

loadCopy({ quiet: true })
const fixture = JSON.parse(await readFile(join(HERE, 'fixture.json'), 'utf8'))

// --- the chart -------------------------------------------------------------

// Priced the way the game prices it: the plot is quotes, not readings, so a
// falling <Z> has to become a rising line here as well or the blur is being
// tuned against a chart nobody sees.
const priced = (rows) => rows.map((row) => row.map((z, q) => quote(basePrice(fixture.info, q), z)))

const chart = () => renderEmission({
  kind: 'traces',
  n: fixture.info.n,
  holdings: list('holdings').slice(0, fixture.info.n),
  z: fixture.z_played,
  priced: priced(fixture.z_played),
  clean: priced(fixture.z_clean),
  upto: fixture.z_played.length - 1,
  totalReadouts: fixture.readouts,
  target: fixture.target,
  interventionAt: fixture.invest_at,
  title: `${fixture.spec} - blur bench`,
})

const base = chart()

// --- the blur cache --------------------------------------------------------

// Keyed on everything upstream of the engine. Blend, opacity and gain are
// absent on purpose: they are what the cache exists to make free.
const upstreamKey = (o) => JSON.stringify([
  o.size, o.threshold, o.strength, o.style, o.reach,
  o.engineSize, o.downscaleRegions, o.format, o.quality,
])
const cache = new Map()
let credits = 0

// --- http ------------------------------------------------------------------

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`

async function readBody (req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function run (settings) {
  const o = { ...DEFAULTS, ...settings }
  const key = upstreamKey(o)
  const hit = cache.get(key)
  const out = await blurChart(base, o, { keep: true, blurred: hit || null })
  if (!hit) { cache.set(key, out.blurred); credits += 1 }
  return {
    cached: Boolean(hit),
    credits,
    settings: out.settings,
    size: { full: { width: out.width, height: out.height }, small: out.small },
    stats: out.stats,
    timings: out.timings,
    job: out.job,
    images: {
      threshold: dataUrl(out.stages.threshold),
      blurred: dataUrl(out.stages.blurred),
      upscaled: dataUrl(out.stages.upscaled),
      final: dataUrl(out.png),
    },
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(join(HERE, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(html)
    }
    if (url.pathname === '/base.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
      return res.end(base)
    }
    if (url.pathname.startsWith('/fonts/')) {
      const name = url.pathname.slice('/fonts/'.length)
      if (!/^[A-Za-z[\]]+\.ttf$/.test(name)) { res.writeHead(404); return res.end() }
      const buf = await readFile(join(HERE, '..', 'server', 'fonts', name))
      res.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'max-age=86400' })
      return res.end(buf)
    }
    if (url.pathname === '/meta') {
      // Every colour the chart uses, with where it sits on the luminosity
      // scale the threshold cuts on. It answers the question the threshold
      // slider is really asking - which parts of the picture survive - and it
      // answers it from the renderer's own palette, so it cannot go stale.
      const ruler = [
        ...Object.entries(PALETTE).filter(([k]) => k !== 'qubits')
          .map(([name, hex]) => ({ name, hex })),
        ...PALETTE.qubits.slice(0, fixture.info.n)
          .map((hex, q) => ({ name: `q${q} ${list('holdings')[q]}`, hex })),
      ].map((c) => ({ ...c, luma: Math.round(lumaOfHex(c.hex) * 10) / 10 }))
        .sort((a, b) => a.luma - b.luma)
      return json(res, 200, {
        defaults: DEFAULTS,
        blends: blendNames(),
        ruler,
        fixture: { spec: fixture.spec, n: fixture.info.n, book: fixture.info.book,
                   steps: fixture.readouts, invest_at: fixture.invest_at,
                   target: fixture.target },
        credits,
      })
    }
    if (url.pathname === '/run' && req.method === 'POST') {
      return json(res, 200, await run(await readBody(req)))
    }
    res.writeHead(404); res.end('not found')
  } catch (err) {
    // The message, not the key: an api() failure carries the request path and
    // the upstream detail, neither of which includes the Authorization header.
    console.error(`  ${err.message}`)
    json(res, 500, { error: err.message })
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`
  blur bench   http://localhost:${PORT}
  chart        ${fixture.spec}, ${fixture.info.n} holdings, coupling at step ${fixture.invest_at}
  pipeline     server/blur.mjs
  engine       blur-v2, 1 credit a run (blend and opacity are free)
`)
})
