// env.mjs - read .env before anything else looks at process.env.
//
// This has to be its own module, imported first. ES module imports are
// evaluated before the importing module's body runs, so a loadEnv() call inside
// bot.mjs happens *after* time.mjs has already read MW_TIME_SCALE at its own
// top level - and every setting in .env is silently ignored. Static imports
// evaluate in declaration order, so importing this ahead of the others fixes it.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const path = resolve(dirname(fileURLToPath(import.meta.url)), '.env')
if (existsSync(path)) {
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val   // real env wins
  }
}
