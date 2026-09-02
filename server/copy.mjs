// copy.mjs - every player-facing word lives in copy.yaml, not in the code.
//
// A game writer edits that file alone. The engine passes each message a context
// of values that are ALREADY FORMATTED - {coherence} is the string "0.999", not
// a float - so ordinary lines need no syntax beyond the braces. Filters,
// conditionals and plurals exist for when prose needs to bend, not as the usual
// way to write a line.
//
//   {balance}                        a value, formatted by the engine
//   {balance_raw|money}              a filter, when the default is not wanted
//   {count} opportunit{count|s:y:ies} the plural escape hatch
//   {#if recovering} (…){/if}        a conditional
//   {#if x}a{:else}b{/if}            with an alternative
//
// Nothing here can take the bot down. A missing key, a bad filter or an
// unclosed conditional renders something visible and logs; the round continues.

import { readFileSync, watchFile, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
export const COPY_PATH = process.env.MW_COPY || resolve(HERE, 'copy.yaml')

let COPY = {}
let loadedAt = null
const problems = []

// key -> the context names it has been rendered with. Used by copy-check to
// test each placeholder against what the engine actually provides. Recording
// only when asked keeps it out of the way in normal running.
const RECORD = process.env.MW_COPY_RECORD === '1'
const seenContexts = new Map()
export const recorded = () => seenContexts

// ---------------------------------------------------------------------------
// Loading, with hot reload
// ---------------------------------------------------------------------------

export function loadCopy ({ quiet = false } = {}) {
  try {
    const raw = readFileSync(COPY_PATH, 'utf8')
    const parsed = parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('not a mapping')
    COPY = parsed
    loadedAt = new Date()
    if (!quiet) console.log(`  copy     ${COPY_PATH} loaded`)
    return { ok: true }
  } catch (e) {
    // keep whatever was working; a writer mid-edit should not break a live round
    console.error(`  copy: ${COPY_PATH} could not be read (${e.message}). ` +
      (loadedAt ? 'Keeping the last good version.' : 'Using built-in fallbacks.'))
    return { ok: false, error: e.message }
  }
}

export function watchCopy () {
  if (!existsSync(COPY_PATH)) return
  watchFile(COPY_PATH, { interval: 700 }, () => {
    const r = loadCopy({ quiet: true })
    console.log(r.ok ? '  copy: reloaded' : '  copy: reload failed, keeping previous')
  })
}

export const copyInfo = () => ({ path: COPY_PATH, loadedAt, problems: [...problems] })

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function lookup (key, source = COPY) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), source)
}

export function has (key) { return lookup(key) !== undefined }

/** A list of variants, for anything the writer may supply several phrasings of. */
export function list (key) {
  const v = lookup(key)
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return [v]
  note(`copy: ${key} should be a list`)
  return []
}

/** One variant at random. */
export function pick (key, ctx = {}) {
  const options = list(key)
  if (!options.length) return missing(key)
  return render(options[Math.floor(Math.random() * options.length)], ctx, key)
}

function note (message) {
  if (!problems.includes(message)) {
    problems.push(message)
    console.warn(`  ${message}`)
  }
}

function missing (key) {
  const fallback = FALLBACKS[key]
  note(`copy: no entry for '${key}'`)
  return fallback ?? `[missing copy: ${key}]`
}

// ---------------------------------------------------------------------------
// Filters. The engine pre-formats, so these are for when a writer wants
// something other than the default.
// ---------------------------------------------------------------------------

const FILTERS = {
  '3dp': (v) => Number(v).toFixed(3),
  '4dp': (v) => Number(v).toFixed(4),
  '1dp': (v) => Number(v).toFixed(1),
  round: (v) => String(Math.round(Number(v))),
  money: (v) => `${Math.round(Number(v)).toLocaleString('en-GB')}G`,
  pct: (v) => `${Number(v) >= 0 ? '+' : ''}${(Number(v) * 100).toFixed(1)}%`,
  signed: (v) => `${Number(v) >= 0 ? '+' : ''}${Number(v)}`,
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  // {count|s:opportunity:opportunities}
  s: (v, one, many) => (Number(v) === 1 ? one : many),
}

function applyFilter (value, spec, key) {
  const [name, ...args] = spec.split(':')
  const fn = FILTERS[name]
  if (!fn) {
    note(`copy: '${key}' uses unknown filter '${name}'`)
    return value
  }
  try {
    return fn(value, ...args)
  } catch {
    note(`copy: filter '${name}' failed in '${key}'`)
    return value
  }
}

export const filterNames = () => Object.keys(FILTERS)

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const truthy = (v) => !(v === undefined || v === null || v === false ||
                        v === '' || v === 0)

/** Resolve {#if x}…{:else}…{/if}, innermost first so nesting works. */
function conditionals (tpl, ctx, key) {
  const re = /\{#if\s+([\w.]+)\}((?:(?!\{#if\s)[\s\S])*?)\{\/if\}/
  let out = tpl
  let guard = 0
  while (re.test(out) && guard++ < 50) {
    out = out.replace(re, (_, name, body) => {
      const [whenTrue, whenFalse = ''] = body.split('{:else}')
      if (!(name in ctx)) note(`copy: '${key}' tests '${name}', which is not supplied`)
      return truthy(ctx[name]) ? whenTrue : whenFalse
    })
  }
  if (out.includes('{#if')) note(`copy: '${key}' has an unclosed {#if}`)
  return out
}

/** Fill {name} and {name|filter:args}. */
function interpolate (tpl, ctx, key) {
  return tpl.replace(/\{([\w.]+)((?:\|[^}]*)?)\}/g, (whole, name, filterPart) => {
    if (!(name in ctx)) {
      note(`copy: '${key}' uses {${name}}, which is not supplied`)
      return whole
    }
    let value = ctx[name]
    for (const spec of filterPart.split('|').filter(Boolean)) {
      value = applyFilter(value, spec, key)
    }
    return String(value)
  })
}

export function render (tpl, ctx = {}, key = '(inline)') {
  if (typeof tpl !== 'string') return missing(key)
  return interpolate(conditionals(tpl, ctx, key), ctx, key).trimEnd()
}

/** The main entry point: look a key up and render it. */
export function t (key, ctx = {}) {
  if (RECORD) {
    if (!seenContexts.has(key)) seenContexts.set(key, new Set())
    for (const k of Object.keys(ctx)) seenContexts.get(key).add(k)
  }
  const tpl = lookup(key)
  if (tpl === undefined) return missing(key)
  if (Array.isArray(tpl)) return pick(key, ctx)
  return render(tpl, ctx, key)
}

// ---------------------------------------------------------------------------
// Emergency fallbacks. Terse on purpose - they exist so a broken copy.yaml
// degrades a message rather than the round, not to duplicate the writing.
// ---------------------------------------------------------------------------

const FALLBACKS = {
  'scenes.round': 'Round {round}',
  'scenes.investment': '{world} — progress {progress}/{total}',
  'scenes.offer': 'Three worlds are open to you.',
  'buttons.invest': 'Invest',
  'buttons.observe': 'Observe',
  'buttons.leave': 'Leave',
  'buttons.marketplace': 'Marketplace',
}

/**
 * The two things the game names over and over: a holding within a world, and a
 * moment in its progress. Everything that writes "q1" or "t7" - messages,
 * buttons, and the labels drawn onto the plots - goes through these, so the
 * writer renames them in one place.
 */
export const holding = (index, names) =>
  names?.[index] ?? t('vocabulary.holding', { index })
export const moment = (index) => t('vocabulary.moment', { index })

/**
 * The raw value at a key, template unrendered - an object, an array, anything.
 *
 * `t()` renders and `list()` flattens; a scripted beat needs neither. It needs
 * to know which choices exist before it renders any of them, which means
 * reading the shape a writer authored rather than a string.
 */
export const section = (key) => lookup(key)

export { lookup as _lookup, COPY as _copy }
export const allKeys = () => {
  const out = []
  const walk = (o, prefix) => {
    for (const [k, v] of Object.entries(o || {})) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key)
      else out.push(key)
    }
  }
  walk(COPY, '')
  return out.sort()
}
