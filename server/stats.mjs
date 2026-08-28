// stats.mjs - read events.jsonl and say where the time went.
//
// The question this exists to answer is "what breaks first, and at what
// number of players". So it reports the cost of the things that scale with
// people (model calls, renders, sends) separately from the things that do
// not, and it reports concurrency rather than just totals - five players at
// once is a different machine from five players across an evening.
//
//   npm run stats                 the whole log
//   npm run stats -- --since 2h   the last two hours
//   npm run stats -- --file x     a log copied off a server

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const FILE = resolve(HERE, arg('file', process.env.MW_LOG_FILE || './events.jsonl'))
if (!existsSync(FILE)) {
  console.error(`\n  no log at ${FILE}\n  Play a round first, or pass --file.\n`)
  process.exit(1)
}

const since = (() => {
  const s = arg('since', null)
  if (!s) return 0
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s)
  if (!m) { console.error(`  --since wants 30m, 2h, 7d`); process.exit(1) }
  return Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2]]
})()

const rows = readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((r) => r && r.ts >= since)

if (!rows.length) { console.log('\n  nothing in range\n'); process.exit(0) }

const by = (name) => rows.filter((r) => r.event === name)
const num = (n, d = 0) => n.toLocaleString('en-GB', { maximumFractionDigits: d })

function quantiles (values) {
  if (!values.length) return null
  const v = [...values].sort((a, b) => a - b)
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))]
  return { n: v.length, p50: at(0.5), p95: at(0.95), max: v[v.length - 1],
           total: v.reduce((a, b) => a + b, 0) }
}

const span = (rows[rows.length - 1].ts - rows[0].ts) / 1000
const fmtSpan = span < 90 ? `${num(span)}s` : span < 5400
  ? `${num(span / 60, 1)} min` : `${num(span / 3600, 1)} h`

console.log(`\n  ${FILE}`)
console.log(`  ${num(rows.length)} events over ${fmtSpan}\n`)

// --- what it cost -----------------------------------------------------------
console.log('  where the time goes')
const model = by('model')
const ops = [...new Set(model.map((r) => r.op))]
for (const op of ops) {
  const q = quantiles(model.filter((r) => r.op === op).map((r) => r.ms))
  console.log(`    model ${op.padEnd(7)} ${String(q.n).padStart(4)} calls   ` +
              `p50 ${num(q.p50).padStart(5)}ms   p95 ${num(q.p95).padStart(5)}ms   ` +
              `max ${num(q.max)}ms`)
}
for (const [label, ev, field] of [['render', 'render', 'ms'],
                                  ['turn  ', 'turn', 'ms'],
                                  ['step  ', 'step', 'ms']]) {
  const q = quantiles(by(ev).map((r) => r[field]).filter((x) => x != null))
  if (!q) continue
  console.log(`    ${label}        ${String(q.n).padStart(4)} calls   ` +
              `p50 ${num(q.p50).padStart(5)}ms   p95 ${num(q.p95).padStart(5)}ms   ` +
              `max ${num(q.max)}ms`)
}

// A model call forks a python process holding ~100-165MB, so the peak number
// running at once is the memory figure that actually sizes the box.
const spans = model.map((r) => [r.ts - r.ms, r.ts])
let peak = 0
for (const [s] of spans) {
  const n = spans.filter(([a, b]) => a <= s && b >= s).length
  if (n > peak) peak = n
}
const busy = quantiles(model.map((r) => r.ms))
if (busy) {
  // this can exceed the wall clock, and should: overlapping calls are the point
  console.log(`\n    python: ${num(busy.total / 1000, 1)}s of work over ` +
              `${num(span, 1)}s wall (${num(busy.total / (span * 1000), 2)} avg ` +
              `concurrent, ${peak} peak, so ~${num(peak * 130)}MB at the top)`)
}

// --- who ---------------------------------------------------------------------
const chats = new Set(rows.map((r) => r.chat).filter(Boolean))
const turns = by('turn')
console.log(`\n  play`)
console.log(`    ${chats.size} chat(s), ${num(turns.length)} turns, ` +
            `${num(by('step').length)} posts, ${num(by('render').length)} images`)
const bytes = by('render').reduce((a, r) => a + (r.bytes || 0), 0)
if (bytes) console.log(`    ${num(bytes / 1048576, 1)}MB of images uploaded`)
const days = Math.max(0, ...turns.map((r) => r.day ?? 0))
if (turns.length) console.log(`    furthest game day reached: ${days + 1}`)

// --- what went wrong ---------------------------------------------------------
const failed = by('turn_failed')
const lost = by('session_lost')
const sendFail = by('send_failed')
const stopped = by('polling_stopped')
const boots = by('boot')
console.log(`\n  trouble`)
if (!failed.length && !lost.length && !sendFail.length && !stopped.length) {
  console.log('    none')
} else {
  for (const r of failed) {
    console.log(`    turn failed   ${new Date(r.ts).toISOString()}  ${r.chat}`)
    console.log(`                  ${r.error}`)
    if (r.stack) console.log(`                  ${r.stack}`)
  }
  for (const r of lost) {
    console.log(`    SAVE LOST     ${new Date(r.ts).toISOString()}  ${r.chat}  ` +
                `(${r.why})  - that player started a new game`)
  }
  const perm = sendFail.filter((r) => r.permanent)
  const retried = sendFail.filter((r) => !r.permanent)
  if (retried.length) console.log(`    send retried  ${retried.length}x ` +
    `(${[...new Set(retried.map((r) => r.code))].join(', ')})`)
  if (perm.length) console.log(`    send refused  ${perm.length}x - chat unreachable`)
  for (const r of stopped) {
    console.log(`    POLLING STOPPED ${new Date(r.ts).toISOString()}  ` +
                `${r.code === 409 ? '409 - another instance took the token' : r.error}`)
  }
}

if (boots.length > 1) {
  console.log(`\n    ${boots.length} restarts in this window:`)
  for (const b of boots.slice(-5)) {
    console.log(`      ${new Date(b.ts).toISOString()}  scale ${b.scale}x  ` +
                `${b.local ? 'dev' : 'deployed'}  ${b.resumed} run(s) resumed`)
  }
}
console.log()
