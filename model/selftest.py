#!/usr/bin/env python3
"""
model/selftest.py - the properties the game leans on, checked against the engine.

These are not physics tests. They are the three assumptions the game is built
on, each of which was false at some point while this was written:

  * a world is the same world twice
  * the run you scout is the run you invest in
  * nothing about the player reaches a world before they invest in it

    MW_QDRIVE_API_SRC=/path/to/qdrive-api/src .venv/bin/python3 selftest.py
"""

import os
import sys

import engine

FAIL = 0


def ok(name, cond, detail=''):
    global FAIL
    if cond:
        print(f'  pass  {name}')
    else:
        FAIL += 1
        print(f'  FAIL  {name}' + (f'\n        {detail}' if detail else ''))


def close(a, b, tol=1e-9):
    return all(abs(x - y) <= tol for ra, rb in zip(a, b) for x, y in zip(ra, rb))


SPEC = 'spec_n3_01'
STEPS = 6

# --- a world is the same world twice ----------------------------------------
#
# The engine takes a seed but did not use it for the estimator, so identical
# requests read +0.880, +0.580, +0.930. engine.py shims that; if the shim ever
# stops matching upstream, this is what says so. Without it the cached
# volatility means nothing and no two runs of a world agree.
a = engine.run(SPEC, STEPS, [0, 0, 1], 1.0)['z']
b = engine.run(SPEC, STEPS, [0, 0, 1], 1.0)['z']
ok('a world runs the same way twice', close(a, b),
   f'{[round(v, 3) for v in a[0]]} vs {[round(v, 3) for v in b[0]]}')

# --- nothing about the player reaches the world before they invest -----------
#
# QDrive fits against the whole state, so an apparatus sitting in the circuit
# moves the world's own qubits even uncoupled. It is kept out until the moment
# of investment precisely so this holds - and the prospectus quotes a
# volatility computed once, for every player, before anyone has scouted.
full = engine.run(SPEC, STEPS, [0, 0, 1], 1.0)['z']
spent = engine.run(SPEC, STEPS, [0.6, 0, 0.8], 0.2)['z']
ok('an uncoupled player cannot change a world', close(full, spent),
   f'{[round(v, 3) for v in full[0]]} vs {[round(v, 3) for v in spent[0]]}')

# --- the run you scout is the run you invest in ------------------------------
INVEST = 3
clean = engine.run(SPEC, STEPS, [0, 0, 1], 0.8)['z']
played = engine.run(SPEC, STEPS, [0, 0, 1], 0.8, invest_at=INVEST, target=1)['z']
ok('scouting and playing share every step before the coupling',
   close(clean[:INVEST], played[:INVEST]))
ok('and diverge at it',
   not close(clean[INVEST:], played[INVEST:]),
   'coupling changed nothing - is the ZZ target being applied?')

# --- the apparatus comes back shorter than it went in ------------------------
r = engine.run(SPEC, STEPS, [0, 0, 1], 1.0, invest_at=INVEST, target=1)
ok('holding a position spends coherence', r['coherence'] < 0.99,
   f"came back at {r['coherence']}")
ok('and it is carried, not reset',
   engine.run(SPEC, STEPS, [0, 0, 1], 0.4, invest_at=INVEST, target=1)['coherence']
   < r['coherence'],
   'a player who entered spent should not come back richer than one who did not')

# --- readings stay inside the sphere ----------------------------------------
#
# The estimator is shot-based, so a reading can land outside [-1, 1]; the game
# treats <Z> as bounded (its multiplier is dz/2) and would pay out over par.
ok('every reading is inside [-1, 1]',
   all(-1.0 <= v <= 1.0 for row in a for v in row))

print()
print(f'  {FAIL} failed' if FAIL else '  all good')
sys.exit(1 if FAIL else 0)
