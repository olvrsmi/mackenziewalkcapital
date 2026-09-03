/**
 * tools/fixture.mjs - the chart the bench tunes against.
 *
 * A real run, not an invented one. A threshold has to be judged against the
 * picture the game actually makes: lines that cross, labels pushed apart to
 * stop them overprinting, a dashed counterfactual behind the held line, the
 * amber band after a coupling, and gridlines four levels above the default
 * cut. Made-up numbers give a tidier chart than the game ever draws, and
 * tuning against a tidier chart is tuning against nothing.
 *
 *     MW_QDRIVE_API_SRC=../coupling-playground/qdrive-api/src node tools/fixture.mjs
 *
 * Takes about half a minute: two ten-step runs of the widest world there is,
 * one clean and one coupled, which is why the result is committed rather than
 * computed when the bench starts.
 */

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callModel } from '../server/model.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const SPEC = process.env.MW_FIXTURE_SPEC || 'spec_n7_01'
const STEPS = Number(process.env.MW_STEPS || 10)
const INVEST = Number(process.env.MW_FIXTURE_INVEST || 4)
const TARGET = Number(process.env.MW_FIXTURE_TARGET || 1)

const t0 = Date.now()
console.log(`  ${SPEC}, ${STEPS} steps, coupling at ${INVEST} on q${TARGET}`)

const clean = await callModel({ op: 'scout', circuit: SPEC, readouts: STEPS })
console.log(`  clean run  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
const t1 = Date.now()
const played = await callModel({
  op: 'play', circuit: SPEC, readouts: STEPS,
  invest_at: INVEST, target: TARGET, coherence: 0.85,
})
console.log(`  coupled run  ${((Date.now() - t1) / 1000).toFixed(0)}s`)

if (clean.info.n < 2) throw new Error(`${SPEC} has ${clean.info.n} qubits - nothing to plot`)
if (INVEST >= STEPS - 1) throw new Error(`a coupling at ${INVEST} of ${STEPS} leaves nothing after it`)

await writeFile(join(HERE, 'fixture.json'), JSON.stringify({
  spec: SPEC, info: clean.info, readouts: STEPS,
  invest_at: INVEST, target: TARGET,
  z_clean: clean.z, z_played: played.z,
}, null, 1) + '\n')

console.log(`  wrote fixture.json - ${clean.info.n} holdings, book ${JSON.stringify(clean.info.book)}`)
