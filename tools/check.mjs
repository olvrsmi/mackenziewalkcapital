/**
 * tools/check.mjs - does the bench still expose the whole pipeline?
 *
 * The page and server/blur.mjs agree on a set of knob names by hand, and a
 * disagreement is silent in the worst way: a control that tunes nothing, or a
 * setting with no control, either of which makes the bench lie about what the
 * box will do. So the two lists are compared rather than trusted.
 *
 *     node tools/check.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, blendNames, BLEND_MODES, gainUp, canvasOf } from '../server/blur.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let bad = 0
const ok = (name, pass, detail = '') => {
  if (!pass) bad += 1
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? '  - ' + detail : ''}`)
}

const html = await readFile(join(HERE, 'index.html'), 'utf8')
const fixture = JSON.parse(await readFile(join(HERE, 'fixture.json'), 'utf8'))

// --- the knobs -------------------------------------------------------------
const knobs = JSON.parse(
  (html.match(/const KNOBS = (\[[^\]]*\])/s) || [])[1].replace(/'/g, '"'))
const controls = [...html.matchAll(/<(?:input|select)[^>]*\bid="([a-zA-Z]+)"/g)].map((m) => m[1])
const ids = new Set([...html.matchAll(/\bid="([a-zA-Z0-9-]+)"/g)].map((m) => m[1]))

// jpeg quality has no meaning for a png upload, and the checkbox and the
// number live under the same names in both places - so this is a plain
// two-way comparison with nothing exempt.
const missingControl = knobs.filter((k) => !controls.includes(k))
const missingDefault = knobs.filter((k) => !(k in DEFAULTS))
const untunable = Object.keys(DEFAULTS).filter((k) => !knobs.includes(k))

ok('every knob the page lists has a control', !missingControl.length, missingControl.join(' '))
ok('every knob the page lists exists in DEFAULTS', !missingDefault.length, missingDefault.join(' '))
ok('every pipeline setting has a control', !untunable.length,
   untunable.length ? `no control for ${untunable.join(' ')}` : '')

// --- the dom ---------------------------------------------------------------
const refs = [...html.matchAll(/\$\('([a-zA-Z0-9-]+)'\)/g)].map((m) => m[1])
const dangling = [...new Set(refs)].filter((r) => !ids.has(r))
ok('every element the script reaches for exists', !dangling.length, dangling.join(' '))

const readouts = knobs.filter((k) => {
  const el = html.match(new RegExp(`<input[^>]*id="${k}"[^>]*>`))
  return el && /type=range/.test(el[0])
}).filter((k) => !ids.has('v-' + k))
ok('every slider has a value readout', !readouts.length, readouts.join(' '))

// --- what is free ---------------------------------------------------------
// The cache key in serve.mjs decides what costs a credit. Anything downstream
// of the engine must be out of it, or dragging a blend mode bills for a blur.
const serve = await readFile(join(HERE, 'serve.mjs'), 'utf8')
const key = (serve.match(/const upstreamKey = \(o\) => JSON\.stringify\(\[([^\]]*)\]/s) || [])[1] || ''
for (const free of ['blend', 'opacity', 'gain']) {
  ok(`${free} is not in the cache key`, !new RegExp(`\\bo\\.${free}\\b`).test(key))
}
const upstream = ['size', 'threshold', 'strength', 'style', 'reach', 'format', 'quality']
const leaked = upstream.filter((k) => !new RegExp(`\\bo\\.${k}\\b`).test(key))
ok('every engine-facing setting is in the cache key', !leaked.length, leaked.join(' '))

// --- the blend list -------------------------------------------------------
ok('the default blend exists', Boolean(BLEND_MODES[DEFAULTS.blend]), DEFAULTS.blend)
ok('vivid light is identity at the midpoint',
   Math.abs(BLEND_MODES['vivid-light'](0.37, 0.5) - 0.37) < 1e-12)
ok('every blend mode is a function', blendNames().every((b) => typeof BLEND_MODES[b] === 'function'))

// A gain of 1 leaves the overlay alone. The BEHAVIOUR, not the default: what
// the defaults are tuned to is a decision made at the bench, and an earlier
// version of this asserted `DEFAULTS.gain === 1` and went red the moment that
// tuning was committed.
{
  const px = (c) => [...c.getContext('2d').getImageData(0, 0, 4, 4).data].slice(0, 4)
  const filled = (colour) => {
    const { canvas, ctx } = canvasOf(4, 4)
    ctx.fillStyle = colour
    ctx.fillRect(0, 0, 4, 4)
    return canvas
  }

  const flat = filled('rgb(60,90,120)')
  const before = px(flat)
  gainUp(flat, 1)
  ok('a gain of 1 leaves every pixel alone', px(flat).join() === before.join(),
     `${before} -> ${px(flat)}`)
  gainUp(flat, 2)
  ok('a gain of 2 doubles the colour', px(flat).slice(0, 3).join() === '120,180,240',
     `${before} -> ${px(flat)}`)
  gainUp(flat, 8)
  ok('and it clamps rather than wrapping', px(flat).slice(0, 3).join() === '255,255,255',
     String(px(flat)))

  // Alpha on its own, with a half-transparent fill: an overlay that came back
  // with transparency must keep it, or the blend weights it as if it were
  // black. Opaque above because the canvas keeps colour premultiplied and
  // unpremultiplying rounds - 200 comes back 201 and doubles to 161, not 160.
  const soft = filled('rgba(80,120,200,0.5)')
  const alphaBefore = px(soft)[3]
  gainUp(soft, 3)
  ok('gain never touches alpha', px(soft)[3] === alphaBefore,
     `${alphaBefore} -> ${px(soft)[3]}`)
}

// The defaults are hand-edited now that they carry tuning, so they are checked
// against what blur-v2 and the pipeline will actually accept rather than
// against particular values.
const RANGES = {
  size: [8, 2048], threshold: [1, 255], opacity: [0, 1], gain: [0.01, 64],
  strength: [0, 1], reach: [0, 1], engineSize: [8, 1024], quality: [0.1, 1],
}
for (const [k, [lo, hi]] of Object.entries(RANGES)) {
  ok(`the default ${k} is in range`, DEFAULTS[k] >= lo && DEFAULTS[k] <= hi,
     `${DEFAULTS[k]}, allowed ${lo}..${hi}`)
}
ok('the default gate is one blur-v2 knows', ['rx', 'ry'].includes(DEFAULTS.style))
ok('the default upload format is one the API takes',
   ['png', 'jpeg'].includes(DEFAULTS.format))

// --- the fixture ----------------------------------------------------------
ok('the fixture is the widest world there is', fixture.info.n === 7,
   `n=${fixture.info.n}`)
ok('the fixture has a coupling to show', Number.isInteger(fixture.invest_at),
   `at step ${fixture.invest_at}`)
ok('the coupling is partway through, not at either end',
   fixture.invest_at > 0 && fixture.invest_at < fixture.readouts - 1)
ok('the fixture carries both runs, so the ghost line draws',
   Array.isArray(fixture.z_clean) && Array.isArray(fixture.z_played) &&
   fixture.z_clean.length === fixture.z_played.length)
ok('the two runs differ after the coupling',
   JSON.stringify(fixture.z_clean.slice(fixture.invest_at + 1)) !==
   JSON.stringify(fixture.z_played.slice(fixture.invest_at + 1)))

console.log(bad ? `\n  ${bad} problem(s)\n` : '\n  all good\n')
process.exit(bad ? 1 : 0)
