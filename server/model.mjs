// model.mjs - the bridge to model/engine.py.
//
// One JSON request in on stdin, one JSON response out on stdout, then the
// process exits. Python startup is ~0.4s and a round needs two or three calls,
// so a persistent worker buys nothing - the run is paced at fifteen seconds a
// step regardless.
//
// MW_PYTHON overrides the interpreter. Otherwise a venv inside model/ is
// preferred, falling back to python3 on PATH. Whatever is used needs
// model/requirements.txt satisfied.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MODEL_DIR = resolve(HERE, '..', 'model')
const ENGINE = join(MODEL_DIR, 'engine.py')

function findPython () {
  if (process.env.MW_PYTHON) return process.env.MW_PYTHON
  for (const candidate of [join(MODEL_DIR, '.venv', 'bin', 'python3'),
                           join(MODEL_DIR, '.venv', 'Scripts', 'python.exe')]) {
    if (existsSync(candidate)) return candidate
  }
  return 'python3'
}
const PYTHON = findPython()

const TIMEOUT_MS = Number(process.env.MW_MODEL_TIMEOUT || 120000)

export function modelInfo () {
  return { python: PYTHON, engine: ENGINE, timeoutMs: TIMEOUT_MS }
}

export async function callModel (request) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(PYTHON, [ENGINE], {
      cwd: MODEL_DIR,
      env: { ...process.env, PYTHONWARNINGS: 'ignore' },
    })
    let out = ''
    let err = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`model timed out after ${TIMEOUT_MS}ms on op '${request.op}'`))
    }, TIMEOUT_MS)

    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(
        `could not start python (${PYTHON}): ${e.message}\n` +
        'Set MW_PYTHON, or create model/.venv and install model/requirements.txt.'))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0 && !out.trim()) {
        // The tail of a traceback is usually the least informative part of it.
        // Surface the exception line, and name the two failures that actually
        // happen in practice: no qiskit at all, or a Python whose version
        // qiskit does not work on (3.10.7 raises a TypeError inside
        // qiskit.passmanager on import, while 3.10.13 is fine).
        const lines = err.trim().split('\n').filter(Boolean)
        const exc = [...lines].reverse().find((l) => /^\w+(\.\w+)*(Error|Exception):/.test(l.trim()))
        let hint = ''
        if (/ModuleNotFoundError: No module named/.test(err)) {
          hint = '\nThat interpreter is missing the model dependencies. ' +
                 'Install model/requirements.txt into it, or point MW_PYTHON elsewhere.'
        } else if (/qiskit/.test(err) && /TypeError|Callable/.test(err)) {
          hint = '\nThat looks like an incompatible Python for this qiskit ' +
                 '(3.10.7 fails inside qiskit.passmanager on import; 3.10.13 works). ' +
                 'Point MW_PYTHON at a different interpreter.'
        }
        return reject(new Error(
          `model (${PYTHON}) exited ${code}: ${exc || lines.slice(-1)[0] || 'no output'}${hint}`))
      }
      let parsed
      try {
        parsed = JSON.parse(out)
      } catch {
        return reject(new Error(
          `model returned unparseable output: ${out.trim().slice(0, 200)}` +
          (err.trim() ? ` | stderr: ${err.trim().slice(-200)}` : '')))
      }
      if (!parsed.ok) return reject(new Error(parsed.error || 'model reported failure'))
      resolvePromise(parsed)
    })

    child.stdin.write(JSON.stringify(request))
    child.stdin.end()
  })
}
