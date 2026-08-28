// copy-check.mjs - verify copy.yaml before anyone plays on it.
//
//   npm run copy-check
//
// Two directions, because either can be wrong:
//   * every key the code asks for exists in copy.yaml
//   * every {placeholder} a message uses is one the engine actually supplies
//
// The second needs to know what each message is given, which is what the
// comments above each entry in copy.yaml document. Rather than duplicate that
// as a schema, this plays a full round with a recording engine and notes the
// real context of every message it renders — so the check tests what the game
// actually does, not what a list claims it does.

import './env.mjs'
import { readFileSync } from 'node:fs'

process.env.MW_COPY_RECORD = '1'   // before copy.mjs is evaluated

const { COPY_PATH, loadCopy, allKeys, _lookup, filterNames, recorded } =
  await import('./copy.mjs')

const problems = []
loadCopy({ quiet: true })

// --- play a round, so the common paths are all rendered at least once -------
const game = await import('./game.mjs')
const S = game.newSession(11)
await game.boot(S)
const script = ['1', 'o', 'i', '250', '1', '4']
for (const tok of script) await game.handle(S, tok)
if (S.run) { S.run.startedMs -= 3600_000; let d = false
  while (!d) d = game.step(S).done }
await game.handle(S, 'm')
await game.handle(S, 'b')
await game.handle(S, '10')
await game.handle(S, 'l')
await game.handle(S, 'help')

const seen = recorded()

// --- 1. keys referenced in code that copy.yaml does not define -------------
const sources = ['game.mjs', 'bot.mjs', 'render.mjs']
const referenced = new Set()
for (const f of sources) {
  const src = readFileSync(new URL(f, import.meta.url), 'utf8')
  for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) referenced.add(m[1])
  for (const m of src.matchAll(/\b(?:list|pick)\(\s*'([\w.]+)'/g)) referenced.add(m[1])
  // t(cond ? 'a.b' : 'c.d', …)
  for (const m of src.matchAll(/\bt\(\s*[^)]*\?\s*'([\w.]+)'\s*:\s*'([\w.]+)'/g)) {
    referenced.add(m[1]); referenced.add(m[2])
  }
}
const defined = new Set(allKeys())
for (const key of [...referenced].sort()) {
  const v = _lookup(key)
  if (v === undefined) problems.push(`missing key: '${key}' is used in code`)
}

// --- 2. placeholders and filters inside each template ----------------------
const PLACEHOLDER = /\{([\w.]+)((?:\|[^}]*)?)\}/g
const CONDITION = /\{#if\s+([\w.]+)\}/g
const known = new Set(filterNames())

function checkTemplate (key, tpl) {
  if (typeof tpl !== 'string') return
  const opens = (tpl.match(/\{#if/g) || []).length
  const closes = (tpl.match(/\{\/if\}/g) || []).length
  if (opens !== closes) {
    problems.push(`unbalanced conditional in '${key}': ` +
                  `${opens} {#if} but ${closes} {/if}`)
  }
  const supplied = seen.get(key)
  for (const m of tpl.matchAll(PLACEHOLDER)) {
    for (const spec of m[2].split('|').filter(Boolean)) {
      const name = spec.split(':')[0]
      if (!known.has(name)) {
        problems.push(`unknown filter '${name}' in '${key}' ` +
                      `(available: ${[...known].join(', ')})`)
      }
    }
    if (supplied && !supplied.has(m[1])) {
      problems.push(`'${key}' uses {${m[1]}}, which the engine does not supply` +
                    ` (it gives: ${[...supplied].sort().join(', ')})`)
    }
  }
  for (const m of tpl.matchAll(CONDITION)) {
    if (supplied && !supplied.has(m[1])) {
      problems.push(`'${key}' tests {#if ${m[1]}}, which the engine does not supply`)
    }
  }
}

for (const key of allKeys()) {
  const v = _lookup(key)
  if (Array.isArray(v)) v.forEach((line) => checkTemplate(key, line))
  else checkTemplate(key, v)
}

// --- 3. keys defined but never used ---------------------------------------
const unusedSkip = ['worlds', 'vocabulary.complexity', 'chatter']
const unused = allKeys().filter((k) =>
  !referenced.has(k) && !unusedSkip.some((p) => k.startsWith(p)) &&
  !seen.has(k))

// --- report ---------------------------------------------------------------
console.log(`\n  ${COPY_PATH}`)
console.log(`  ${allKeys().length} entries · ${referenced.size} referenced in code · ` +
            `${seen.size} exercised by a test round\n`)

if (unused.length) {
  console.log('  not used anywhere (harmless, but perhaps stale):')
  for (const k of unused) console.log(`    ${k}`)
  console.log()
}

if (!problems.length) {
  console.log('  no problems found.\n')
  process.exit(0)
}
console.log(`  ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`)
for (const p of problems) console.log(`    ${p}`)
console.log()
process.exit(1)
