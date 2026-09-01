#!/usr/bin/env python3
"""
model/genspecs.py - write the world specifications.

A world used to be a QASM circuit sliced into readouts. Under the QDrive engine
there is no circuit to slice: a world is a *specification* - a set of target
expectation values that get re-applied to the running circuit every step, for as
many steps as the game asks for. This writes those specifications.

The expectation values are random, standing in for whatever real specifications
eventually replace them. What is not random is the shape of the set: the qubit
counts match the spread of the QASMBench circuits they replace, so worlds stay
the same range of sizes they were.

    3 x 2 qubits    6 x 4 qubits    2 x 6 qubits
    5 x 3 qubits    3 x 5 qubits    1 x 7 qubits

Rerunning this reproduces the same twenty specifications byte for byte; it is
seeded. Delete specs/ first if you want the character cache rebuilt too.

    python3 genspecs.py [--out specs]
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))

# the qubit-count histogram of the 20 playable QASMBench circuits
SPREAD = {2: 3, 3: 5, 4: 6, 5: 3, 6: 2, 7: 1}

MASTER_SEED = 20260901
PAULIS = 'IXYZ'


def rand_expvals(rnd, k):
    """k distinct two-qubit Pauli words with values in [-1, 1].

    Whole numbers turn up deliberately often: a target of exactly -1 or +1 asks
    for a fully polarised correlation and moves a qubit much harder than 0.37
    does, which is where a world's character comes from.
    """
    words = [a + b for a in PAULIS for b in PAULIS if a + b != 'II']
    out = {}
    for word in rnd.sample(words, k):
        out[word] = rnd.choice([-1.0, 1.0]) if rnd.random() < 0.3 \
            else round(rnd.uniform(-1.0, 1.0), 2)
    return out


def make_spec(n, index, rnd):
    """One world: a ring of two-qubit targets, each re-applied every step.

    A ring rather than random pairs, so every qubit is reachable from every
    other and no qubit sits inert - a holding that never moves is a holding
    nobody can trade.
    """
    pairs = [[i, (i + 1) % n] for i in range(n)] if n > 2 else [[0, 1], [1, 0]]
    # fraction is how hard each target pulls per step, so it is most of what
    # separates a placid world from a violent one. Spread it across the set.
    fraction = round(rnd.uniform(0.15, 0.45), 2)
    targets = [
        {'expvals': rand_expvals(rnd, rnd.choice([2, 3, 3])),
         'qubits': pair,
         'fraction': fraction}
        for pair in pairs
    ]
    return {
        'id': f'spec_n{n}_{index:02d}',
        'n': n,
        'seed': rnd.randrange(2 ** 31),
        'fraction': fraction,
        'targets': targets,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(HERE, 'specs'))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    written = []
    for n, count in sorted(SPREAD.items()):
        for i in range(count):
            # seeded per world, so adding a size later does not renumber the rest
            rnd = random.Random(f'{MASTER_SEED}:{n}:{i}')
            spec = make_spec(n, i + 1, rnd)
            path = os.path.join(args.out, f'{spec["id"]}.json')
            with open(path, 'w') as fh:
                json.dump(spec, fh, indent=2)
                fh.write('\n')
            written.append(spec)

    total = sum(SPREAD.values())
    print(f'  {len(written)} specifications in {args.out}')
    for n, count in sorted(SPREAD.items()):
        print(f'    {n} qubits: {count}')
    assert len(written) == total, f'{len(written)} != {total}'


if __name__ == '__main__':
    main()
