#!/usr/bin/env python3
"""
model/engine.py - the quantum side of Office 4B, spoken as JSON.

The Node server owns the game; this owns the physics.  One JSON request on
stdin, one JSON response on stdout, then exit.  Startup is ~0.4s and a round
needs only two or three calls, so a persistent worker buys nothing here -
especially with the run paced at fifteen seconds a step.

    echo '{"op":"worlds"}'                                   | python3 engine.py
    echo '{"op":"scout","circuit":"qft_n4","readouts":8}'     | python3 engine.py
    echo '{"op":"play","circuit":"qft_n4","readouts":8,
           "invest_at":3,"target":1,"coherence":0.7}'         | python3 engine.py

Every response is {"ok": true, ...} or {"ok": false, "error": "..."}.

WHAT THE PLAYER'S QUBIT IS
--------------------------
An apparatus qubit sits outside the circuit, plus a hidden qubit behind it.  The
apparatus is prepared to a carried direction *and length*: measured across many
runs it always comes back with X and Y wiped and only Z surviving, i.e. a mixed
state, and set_bloch alone cannot re-create that - it applies a unitary to a pure
qubit, so it would renormalise (0,0,0.47) back to (0,0,1) and the carry-over
would die after one round.  So:

    RY(arccos c) on the hidden qubit, then CNOT onto the apparatus
        -> apparatus is mixed on +Z with |r| = c exactly
    set_bloch(direction, apparatus)
        -> rotates the axis; eigenvalues, hence |r|, are preserved

Coherence is therefore measured, never assumed: it is |r| of the apparatus's
Bloch vector read from the exact statevector at the end of a run.
"""

from __future__ import annotations

import glob
import json
import os
import sys

os.environ.setdefault('PYTHONWARNINGS', 'ignore')
import warnings
warnings.filterwarnings('ignore')

import numpy as np
from qiskit import QuantumCircuit, qasm2, transpile
from qiskit.converters import circuit_to_dag
from qiskit.quantum_info import Statevector, SparsePauliOp

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from quantumgraph import QuantumGraph                       # noqa: E402

CIRCUIT_DIR = os.path.join(HERE, 'circuits', 'qasmbench_small')
SHOTS = 8192          # only for the two QuantumGraph gate constructions
DEFAULT_READOUTS = 8


# ----------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------

class Unusable(Exception):
    pass


def load(circuit_id):
    path = os.path.join(CIRCUIT_DIR, circuit_id + '.qasm')
    if not os.path.exists(path):
        raise Unusable(f"no circuit '{circuit_id}'")
    try:
        raw = qasm2.load(path, custom_instructions=qasm2.LEGACY_CUSTOM_INSTRUCTIONS)
    except Exception as e:
        raise Unusable(f"the Qiskit QASM parser rejects this file: {type(e).__name__}")

    # Trailing measurements are fine and are stripped.  Anything mid-circuit is
    # not: pairwise tomography appends its own measurements, so a classical
    # register already in the circuit shifts every outcome bitstring and the
    # fitter misparses all of it - silently, with no error raised.
    last = max((i for i, ins in enumerate(raw.data)
                if ins.operation.name not in ('measure', 'barrier')), default=-1)
    bad = []
    if any(ins.operation.name == 'measure' and i < last
           for i, ins in enumerate(raw.data)):
        bad.append('mid-circuit measurement')
    if 'reset' in raw.count_ops():
        bad.append('reset')
    if any(getattr(ins.operation, 'condition', None) is not None for ins in raw.data):
        bad.append('classical conditional')
    if bad:
        raise Unusable(', '.join(bad))

    qc = raw.remove_final_measurements(inplace=False).decompose(reps=5)

    def wide(c):
        # barriers span every qubit by design and are dropped when the DAG is
        # sliced into layers, so they are not multi-qubit gates for our purposes
        return sorted({i.operation.name for i in c.data
                       if i.operation.num_qubits > 2 and i.operation.name != 'barrier'})

    if wide(qc):
        qc = transpile(qc, basis_gates=['u', 'cx'], optimization_level=0)
    if wide(qc):
        raise Unusable(f"gates on more than two qubits survive: {wide(qc)}")

    pairs = sorted({tuple(sorted(qc.find_bit(b).index for b in i.qubits))
                    for i in qc.data if i.operation.num_qubits == 2})
    n = qc.num_qubits
    return qc, {'id': circuit_id, 'n': n, 'gates': len(qc.data),
                'depth': qc.depth(), 'pairs': [list(p) for p in pairs],
                'max_pairs': n * (n - 1) // 2,
                'components': components(n, pairs)}


def components(n, pairs):
    adj = {i: set() for i in range(n)}
    for a, b in pairs:
        adj[a].add(b)
        adj[b].add(a)
    seen, out = set(), []
    for s in range(n):
        if s in seen:
            continue
        comp, stack = {s}, [s]
        seen.add(s)
        while stack:
            x = stack.pop()
            for y in adj[x] - seen:
                seen.add(y)
                comp.add(y)
                stack.append(y)
        out.append(sorted(comp))
    return out


def layers_of(qc):
    """Gates grouped into DAG layers - the moments the circuit actually has."""
    out = []
    for lay in circuit_to_dag(qc).layers():
        nodes = [nd for nd in lay['graph'].op_nodes() if nd.op.name != 'barrier']
        if nodes:
            out.append([(nd.op, [qc.find_bit(b).index for b in nd.qargs])
                        for nd in nodes])
    return out


def cuts_for(n_layers, readouts):
    """Readout depths, equally spaced. A depth-D circuit has D+1 places to
    stand, so more readouts than that would repeat cuts and render identical
    snapshots as flat stretches; clamp instead."""
    readouts = max(3, min(readouts, n_layers + 1))
    return [int(round(n_layers * k / (readouts - 1))) for k in range(readouts)]


# ----------------------------------------------------------------------------
# Readouts
# ----------------------------------------------------------------------------

def z_all(qc, n):
    sv = Statevector(qc)
    nq = qc.num_qubits
    return [round(float(np.real(sv.expectation_value(
        SparsePauliOp.from_sparse_list([("Z", [q], 1.0)], nq)))), 6)
        for q in range(n)]


def bloch(qc, q):
    sv = Statevector(qc)
    nq = qc.num_qubits
    return [round(float(np.real(sv.expectation_value(
        SparsePauliOp.from_sparse_list([(p, [q], 1.0)], nq)))), 6)
        for p in ('X', 'Y', 'Z')]


def prepare(graph, qc, app, hidden, direction, coherence):
    """Apparatus to an exact length and direction. See the module docstring."""
    c = float(np.clip(coherence, 0.0, 1.0))
    qc.ry(float(np.arccos(np.clip(c, -1.0, 1.0))), hidden)
    qc.cx(hidden, app)
    graph.qc = qc
    graph.update_tomography(shots=SHOTS)
    d = np.asarray(direction, float)
    d = d / max(float(np.linalg.norm(d)), 1e-12)
    graph.set_bloch({'X': float(d[0]), 'Y': float(d[1]), 'Z': float(d[2])},
                    app, update=True)


def run(circuit_id, readouts, direction, coherence, invest_at=None, target=None):
    """Walk the circuit, reading <Z> at each cut. Couples at invest_at if given."""
    qc0, info = load(circuit_id)
    layers = layers_of(qc0)
    cuts = cuts_for(len(layers), readouts)
    n = info['n']
    app, hidden, nq = n, n + 1, n + 2

    graph = QuantumGraph(nq, coupling_map=[(app, q) for q in range(n)]
                         + [(app, hidden)])
    qc = QuantumCircuit(nq)
    prepare(graph, qc, app, hidden, direction, coherence)

    z, prev = [], 0
    for k, cut in enumerate(cuts):
        for lay in layers[prev:cut]:
            for op, qargs in lay:
                qc.append(op, qargs)
        prev = cut
        z.append(z_all(qc, n))
        if invest_at is not None and k == invest_at:
            graph.qc = qc
            graph.update_tomography(shots=SHOTS)
            graph.set_relationship({'ZZ': 1}, app, target, update=True)

    final = bloch(qc, app)
    return {'info': info, 'cuts': cuts, 'n_layers': len(layers), 'z': z,
            'apparatus': final,
            'coherence': round(float(np.linalg.norm(final)), 6),
            'layers': [[list(qargs) for _, qargs in lay] for lay in layers]}


# ----------------------------------------------------------------------------
# Operations
# ----------------------------------------------------------------------------

STATS_CACHE = os.path.join(CIRCUIT_DIR, '_stats_cache.json')


def circuit_character(circuit_id):
    """How much this circuit's qubits actually move, with no player in it.

    Worlds are offered before they are scouted, so volatility has to be known in
    advance. It can be: the apparatus qubit is never coupled during a clean run,
    so by no-signalling nothing about the player changes a circuit qubit's
    readout - the trace is a property of the circuit alone. That also means it
    need only ever be computed once, so it is cached to disk.

    volatility is the mean over qubits of how far <Z> ranges across the
    readouts, in [0, 2]. A circuit whose qubits sit still has nothing to bet on.
    """
    qc, info = load(circuit_id)
    layers = layers_of(qc)
    cuts = cuts_for(len(layers), DEFAULT_READOUTS)
    n = info['n']

    acc = QuantumCircuit(n)
    rows, prev = [], 0
    for cut in cuts:
        for lay in layers[prev:cut]:
            for op, qargs in lay:
                acc.append(op, qargs)
        prev = cut
        rows.append(z_all(acc, n))

    cols = list(zip(*rows))
    ranges = [max(c) - min(c) for c in cols]
    volatility = sum(ranges) / len(ranges) if ranges else 0.0
    inert = [q for q, r in enumerate(ranges) if r < 1e-6]
    return {'volatility': round(volatility, 4),
            'per_qubit_range': [round(r, 4) for r in ranges],
            'inert_qubits': inert}


def load_stats_cache():
    if os.path.exists(STATS_CACHE):
        try:
            with open(STATS_CACHE) as fh:
                return json.load(fh)
        except Exception:
            pass
    return {}


def op_worlds(req):
    """Every circuit small enough to stay responsive, with its structure."""
    max_q = int(req.get('max_qubits', 7))
    max_d = int(req.get('max_depth', 120))
    readouts = int(req.get('readouts', DEFAULT_READOUTS))
    cache, dirty = load_stats_cache(), False
    out, skipped = [], []
    for f in sorted(glob.glob(os.path.join(CIRCUIT_DIR, '*.qasm'))):
        cid = os.path.basename(f)[:-5]
        try:
            qc, info = load(cid)
        except Unusable as e:
            skipped.append({'id': cid, 'why': str(e)})
            continue
        depth = len(layers_of(qc))
        if info['n'] > max_q or depth > max_d or depth + 1 < readouts:
            skipped.append({'id': cid, 'why': f'out of range (n={info["n"]}, '
                                              f'depth={depth})'})
            continue
        info['readouts'] = len(cuts_for(depth, readouts))
        info['connected'] = len(info['components']) == 1
        info['layers_count'] = depth
        if cid not in cache:
            cache[cid] = circuit_character(cid)
            dirty = True
        info.update(cache[cid])
        out.append(info)

    if dirty:
        try:
            with open(STATS_CACHE, 'w') as fh:
                json.dump(cache, fh)
        except Exception:
            pass          # a cache that cannot be written is not an error
    return {'worlds': out, 'skipped': skipped}


def op_scout(req):
    """The clean run: what happens with no intervention."""
    r = run(req['circuit'], int(req.get('readouts', DEFAULT_READOUTS)),
            req.get('direction', [0.0, 0.0, 1.0]),
            float(req.get('coherence', 1.0)))
    return {'info': r['info'], 'cuts': r['cuts'], 'n_layers': r['n_layers'],
            'z': r['z'], 'layers': r['layers']}


def op_play(req):
    """Couple at invest_at, then finish. Also returns what the qubit came back as."""
    r = run(req['circuit'], int(req.get('readouts', DEFAULT_READOUTS)),
            req.get('direction', [0.0, 0.0, 1.0]),
            float(req.get('coherence', 1.0)),
            invest_at=int(req['invest_at']), target=int(req['target']))
    return {'cuts': r['cuts'], 'z': r['z'], 'apparatus': r['apparatus'],
            'coherence': r['coherence']}


OPS = {'worlds': op_worlds, 'scout': op_scout, 'play': op_play}


def main():
    try:
        req = json.load(sys.stdin)
        fn = OPS.get(req.get('op'))
        if fn is None:
            raise Unusable(f"unknown op '{req.get('op')}'; "
                           f"expected one of {sorted(OPS)}")
        out = fn(req)
        out['ok'] = True
        json.dump(out, sys.stdout)
    except Unusable as e:
        json.dump({'ok': False, 'error': str(e)}, sys.stdout)
    except Exception as e:                       # noqa: BLE001
        json.dump({'ok': False, 'error': f'{type(e).__name__}: {e}'}, sys.stdout)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
