#!/usr/bin/env python3
"""
model/engine.py - the quantum side of Office 4B, spoken as JSON.

The Node server owns the game; this owns the physics.  One JSON request on
stdin, one JSON response on stdout, then exit.

    echo '{"op":"worlds"}'                                | python3 engine.py
    echo '{"op":"scout","circuit":"spec_n3_01"}'          | python3 engine.py
    echo '{"op":"play","circuit":"spec_n3_01",
           "invest_at":3,"target":1,"coherence":0.7}'     | python3 engine.py

Every response is {"ok": true, ...} or {"ok": false, "error": "..."}.

WHAT A WORLD IS NOW
-------------------
It used to be a QASM circuit, sliced into readouts at DAG-layer boundaries: a
fixed thing of finite length that the player moved through.  Under the QDrive
engine there is nothing to slice.  A world is a *specification* - a set of
target expectation values - and a step applies all of them to the circuit the
last step produced, chained in through `initial_circuit`.  It would run forever
if you let it; MW_STEPS says how long to let it.

So "readout k" is now "the state after step k", and the circuit grows by about
3KB a step rather than being consumed.  Everything the server sees is otherwise
unchanged: same three ops, same shapes.

WHAT THE PLAYER'S QUBIT IS
--------------------------
An apparatus qubit sits outside the specification's qubits, plus a hidden qubit
behind it.  The apparatus is prepared to a carried direction *and length*, and
that length is the whole coherence economy - so it has to survive being handed
back in next round.

QDrive cannot do that on its own.  Asking it for a short Bloch vector by
targeting the expectation values directly gets the direction right and the
length wrong: it drives a unitary circuit, so an isolated single-qubit target
can only ever land on the sphere's surface, and every purity from 1.0 down to
0.05 comes back at |r| = 1.  Measured, not assumed.

So the apparatus is prepared the way it always was, as an explicit circuit
handed to the first step as `initial_circuit`:

    RY(arccos c) on the hidden qubit, then CNOT onto the apparatus
        -> apparatus is mixed on +Z with |r| = c
    RY/RZ on the apparatus
        -> rotates the axis; eigenvalues, hence |r|, are preserved

Coupling then drains it on its own, which is the point: hold a position across
several steps and the apparatus comes back shorter than it went in.

WHERE THE ENGINE COMES FROM
---------------------------
qdrive-api and QDrive are both private, and this repository is public, so
neither is vendored here.  MW_QDRIVE_API_SRC points at a clone's src/ (deploy.sh
puts one beside the app); requirements.txt installs QDrive itself over SSH.
"""

from __future__ import annotations

import glob
import importlib.util
import itertools
import json
import math
import os
import sys
import zlib

os.environ.setdefault('PYTHONWARNINGS', 'ignore')
import warnings
warnings.filterwarnings('ignore')

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC_DIR = os.path.join(HERE, 'specs')
STATS_CACHE = os.path.join(SPEC_DIR, '_stats_cache.json')

# How many times a world is stepped. There is no natural end - the specification
# would keep being applied forever - so this is the whole answer to "how long is
# a round", and it is meant to be turned while testing.
STEPS = int(os.environ.get('MW_STEPS', '10'))


class Unusable(Exception):
    """A world that cannot be played, said in a way the server can show."""


# ----------------------------------------------------------------------------
# The engine
# ----------------------------------------------------------------------------

def _load_qdrive_engine():
    """Import qdrive-api's engine.py under a name of its own.

    Its src/ has to go on sys.path because it does flat `from backend import`
    imports - but src/engine.py and *this* file are both called engine.py, so a
    plain `import engine` is a coin toss between them depending on how this was
    invoked. Loading it from an explicit path under an explicit name settles it.
    """
    src = os.environ.get('MW_QDRIVE_API_SRC')
    if not src:
        # Deployed, the engine sits beside the app rather than inside it: the app
        # is a git clone the service cannot write, and the engine is sent
        # separately. Both places are tried so a checkout laid out either way
        # works without setting anything.
        for candidate in (os.path.join(HERE, '..', '..', 'vendor', 'qdrive-api', 'src'),
                          os.path.join(HERE, 'vendor', 'qdrive-api', 'src')):
            if os.path.isdir(candidate):
                src = candidate
                break
        else:
            src = os.path.join(HERE, '..', '..', 'vendor', 'qdrive-api', 'src')
    src = os.path.abspath(os.path.expanduser(src))
    if not os.path.isdir(src):
        raise Unusable(
            f'no QDrive engine at {src}. Clone moth-quantum/qdrive-api and point '
            'MW_QDRIVE_API_SRC at its src/ directory.')
    if src not in sys.path:
        sys.path.insert(0, src)
    spec = importlib.util.spec_from_file_location(
        'qdrive_api_engine', os.path.join(src, 'engine.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules['qdrive_api_engine'] = module
    try:
        spec.loader.exec_module(module)
    except ModuleNotFoundError as e:
        raise Unusable(
            f'the QDrive engine needs {e.name!r}, which is not installed. '
            'See model/requirements.txt.') from e
    _seed_the_estimator(module)
    return module


def _seed_the_estimator(module):
    """Make the engine reproducible. Remove this when qdrive-api is fixed.

    backend.get_backend() seeds the sampler (`AerSampler(seed=seed)`) but hands
    the estimator its seed as `backend_options={'seed_simulator': seed}`, which
    AerEstimator ignores - it wants `run_options`. So the seed parameter has no
    effect on the estimator at all, and every job is unrepeatable: the same
    circuit and the same observable read +0.068, -0.025, -0.030 on three
    identical runs.

    That matters more here than a little noise would suggest, because QDrive
    fits its next parameters to those readings and the run is chained: a
    fluctuation at step 0 becomes a different trajectory by step 9. The game
    needs a world to be the same world twice - the volatility quoted in the
    prospectus is cached, and the clean run a player scouts has to be the run
    they then invest in.

    Upstream fix, in qdrive-api/src/backend.py:

        run_options={"shots": shots, "seed_simulator": seed}
    """
    import backend

    original = backend.get_backend
    if getattr(original, '_mw_seeded', False):
        return

    def seeded(machine, seed=None, shots=1024, coupling_map=None):
        estimator, sampler = original(machine, seed=seed, shots=shots,
                                      coupling_map=coupling_map)
        if seed is not None:
            try:
                estimator.options.run_options['seed_simulator'] = seed
            except Exception:
                pass          # a newer backend that seeds itself is not an error
        return estimator, sampler

    seeded._mw_seeded = True
    backend.get_backend = seeded
    module.get_backend = seeded      # engine.py did `from backend import ...`


_ENGINE = None


def engine():
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = _load_qdrive_engine()
    return _ENGINE


# ----------------------------------------------------------------------------
# Specifications
# ----------------------------------------------------------------------------

def load(spec_id):
    """One world's specification, checked enough to fail here rather than deep
    inside the engine where the message would mean nothing to a player."""
    path = os.path.join(SPEC_DIR, f'{spec_id}.json')
    if not os.path.isfile(path):
        raise Unusable(f'no specification {spec_id!r}')
    try:
        with open(path) as fh:
            spec = json.load(fh)
    except Exception as e:
        raise Unusable(f'{spec_id} is unreadable: {e}') from e
    if not spec.get('targets'):
        raise Unusable(f'{spec_id} has no targets')
    if 'n' not in spec:
        raise Unusable(f'{spec_id} does not say how many qubits it has')
    n = int(spec['n'])
    if n < 2:
        raise Unusable(f'{spec_id} has n={n}; a target needs two qubits')

    for i, t in enumerate(spec['targets']):
        # A null entry is legitimate: the engine reads it as "flush the queue
        # here" rather than as a target, which is how a specification gets an
        # update part-way through a step instead of only at the end of one.
        if t is None:
            continue
        qubits = t.get('qubits')
        # QDrive itself only takes pairs - one qubit raises "not enough values
        # to unpack" and three raises "too many", several frames deep in a
        # library the writer of a specification has never heard of.
        if not isinstance(qubits, list) or len(qubits) != 2:
            raise Unusable(
                f'{spec_id} target {i} acts on {qubits!r}; targets take exactly '
                'two qubits')
        if any(not isinstance(q, int) or not (0 <= q < n) for q in qubits):
            raise Unusable(
                f'{spec_id} target {i} names qubit(s) outside 0-{n - 1}: {qubits}')

    # The seed is what makes a world the same world twice. Deriving it from the
    # id when absent keeps a hand-written specification reproducible without
    # making whoever wrote it invent a number.
    if spec.get('seed') is None:
        spec['seed'] = zlib.crc32(spec_id.encode('utf-8')) & 0x7fffffff
    return spec


def real_targets(spec):
    """The targets that are actually targets.

    A null entry in the list is not one: the engine reads it as "flush the queue
    here". It does work, but it draws no gate and constrains no correlation, so
    nothing that counts or maps targets should see it.
    """
    return [t for t in spec['targets'] if t is not None]


def info_of(spec):
    """The structural facts the prospectus is built from.

    The old shape came from a circuit's DAG; this one comes from the target set,
    which is the equivalent thing: which holdings are wired to which, and how
    much work happens between readouts.
    """
    n = spec['n']
    targets = real_targets(spec)
    pairs = sorted({tuple(sorted(t['qubits'])) for t in targets})
    return {
        'id': spec['id'],
        'n': n,
        'gates': len(targets) * STEPS,
        'depth': len(targets) * STEPS,
        'pairs': [list(p) for p in pairs],
        'max_pairs': n * (n - 1) // 2,
        # how many Pauli correlations the specification drives every step - what
        # it actually asks of the world, and the only structural number here
        # that varies much between worlds
        'constraints': sum(len(t.get('expvals') or {}) for t in targets),
        # The same count, but per holding: how many Pauli correlations name this
        # qubit. It is a holding's book of business - every expval is a contract
        # the specification holds it to, every step, forever - and it is what the
        # server prices from. Structural, so it costs nothing: no circuit is run
        # and no cache entry is involved.
        'book': [
            sum(1
                for t in targets if q in t['qubits']
                for word in (t.get('expvals') or {})
                # 'I' means the operator does not act on that qubit at all, so
                # an expval keyed 'XI' is a contract on one holding and nothing
                # whatever on the other. Which one is not the obvious one:
                # QDrive follows qiskit's label convention, where the RIGHTMOST
                # letter is qubits[0] - so word position k names
                # qubits[len(word)-1-k], and reading left-to-right mirrors every
                # asymmetric word onto the wrong holding. QDrive's pauli.pad()
                # documents exactly this trap, and notes that symmetric words
                # like 'XX' hide it.
                if word[len(word) - 1 - t['qubits'].index(q)] != 'I')
            for q in range(n)],
        'components': components(n, pairs),
        'fraction': spec.get('fraction'),
        'readouts': STEPS,
    }


def components(n, pairs):
    """Connected components of the target graph, so a world made of two
    unrelated halves can say so."""
    seen, out = set(), []
    adj = {q: set() for q in range(n)}
    for a, b in pairs:
        adj[a].add(b)
        adj[b].add(a)
    for q in range(n):
        if q in seen:
            continue
        stack, comp = [q], []
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            comp.append(cur)
            stack.extend(adj[cur] - seen)
        out.append(sorted(comp))
    return out


def layers_of(spec, steps):
    """The gate map: one entry per target application, in order.

    A step applies every target in turn, so `steps` passes over a three-target
    specification is thirty entries - the repeating pattern a player can see
    in the plot, with a readout line after each pass.
    """
    return [[list(t['qubits'])]
            for _ in range(steps) for t in real_targets(spec)]


def cuts_for(spec, steps):
    """Where the readouts fall in that map: after every complete pass."""
    per = len(real_targets(spec))
    return [(s + 1) * per for s in range(steps)]


# ----------------------------------------------------------------------------
# The apparatus
# ----------------------------------------------------------------------------

def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def unit(direction):
    d = [float(x) for x in (direction or [0.0, 0.0, 1.0])]
    norm = math.sqrt(sum(x * x for x in d))
    return [x / norm for x in d] if norm > 1e-9 else [0.0, 0.0, 1.0]


def enter(circuit, n, direction, coherence):
    """Widen the running circuit so the player's qubit joins it, mid-run.

    The apparatus does NOT sit in the circuit from the start, and this is not a
    detail.  QDrive fits its parameters against the whole state, so an apparatus
    present but uncoupled still moves the specification's own qubits - measured,
    and not subtly: the same world at the same seed reads +0.591 at t2 with a
    full apparatus and -0.228 with a spent one, having never been coupled.  The
    old engine had genuine no-signalling here and the game leans on it, because
    a world's volatility is quoted in the prospectus before anyone has scouted
    it.  Keeping the apparatus out until the moment of investment gives that
    back: up to invest_at, the run is the world alone.

    Takes the QASM3 of the n-qubit circuit so far (or None, when investing at
    the very first step) and returns QASM3 for an (n + 2)-qubit one: the same
    circuit on qubits 0..n-1, the apparatus at n, the hidden qubit behind it at
    n + 1.
    """
    from qiskit import QuantumCircuit, qasm3

    ex, hid = n, n + 1
    wide = QuantumCircuit(n + 2)

    c = clamp(float(coherence), 0.0, 1.0)
    wide.ry(math.acos(c), hid)     # |r| = cos(arccos c) = c, exactly
    wide.cx(hid, ex)
    d = unit(direction)
    wide.ry(math.acos(clamp(d[2], -1.0, 1.0)), ex)
    wide.rz(math.atan2(d[1], d[0]), ex)

    if circuit is not None:
        so_far = qasm3.loads(circuit.decode('utf-8'))
        wide.compose(so_far, qubits=range(n), inplace=True)
    return qasm3.dumps(wide).encode('utf-8')


# ----------------------------------------------------------------------------
# Running a world
# ----------------------------------------------------------------------------

def run(spec_id, steps, direction, coherence, invest_at=None, target=None):
    """Step the world, reading every qubit's <Z> after each step.

    Coupling is *persistent*: from invest_at onward the ZZ target goes on with
    the rest, every step, for as long as the position is held. That is what
    drains the apparatus - one coupling would cost almost nothing.
    """
    spec = load(spec_id)
    n = spec['n']
    ex = n
    if target is not None and not (0 <= int(target) < n):
        raise Unusable(f'holding {target} is outside {spec_id}\'s {n}')

    circuit = None          # step 0 starts from the identity on n qubits
    coherence = clamp(float(coherence), 0.0, 1.0)
    z = []
    apparatus = [x * coherence for x in unit(direction)]

    for k in range(steps):
        targets = list(spec['targets'])
        # Two separate moments, and they used to be one. The apparatus JOINS the
        # circuit at invest_at - an unentangled qubit, which changes nothing
        # anyone can read. It COUPLES from the step after, so the reading the
        # player bought at is the reading they were shown: coupling on the same
        # step moved the quote they had just agreed to.
        joined = invest_at is not None and k >= int(invest_at)
        if joined and k == int(invest_at):
            circuit = enter(circuit, n, direction, coherence)
        if invest_at is not None and k > int(invest_at):
            targets.append({'expvals': {'ZZ': 1.0}, 'qubits': [ex, int(target)]})

        params = {'seed': spec['seed'], 'tomography': 1, 'targets': targets}
        if circuit is None:
            params['n_qubits'] = n
        result = engine().run(params, initial_circuit=circuit)
        circuit = result['files']['circuit'][0]

        tomography = result['output']['tomography']
        # The estimator is shot-based, so a reading can land just outside [-1, 1]
        # - about 0.03 at 1024 shots. The game treats <Z> as bounded (the
        # multiplier is dz/2), so clamp rather than let a 1.04 pay out over par.
        z.append([clamp(float(tomography[str(q)]['Z'] or 0.0), -1.0, 1.0)
                  for q in range(n)])
        if joined:
            apparatus = [clamp(float(tomography[str(ex)][w] or 0.0), -1.0, 1.0)
                         for w in 'XYZ']

    return {
        'info': info_of(spec),
        'cuts': cuts_for(spec, steps),
        'n_layers': len(real_targets(spec)) * steps,
        'layers': layers_of(spec, steps),
        'z': z,
        'apparatus': apparatus,
        'coherence': round(math.sqrt(sum(x * x for x in apparatus)), 6),
    }


def character(spec_id, steps):
    """How much this world's holdings actually move, with nobody in it.

    Worlds are offered before they are scouted, so volatility has to be known in
    advance - and it can be, because until someone invests there is no apparatus
    in the circuit at all (see `enter`). The trace is a property of the world
    alone, so it need only ever be computed once, and is cached to disk.

    volatility is the mean over holdings of how far <Z> ranges across the run,
    in [0, 2]. A world whose holdings sit still has nothing to bet on.
    """
    r = run(spec_id, steps, [0.0, 0.0, 1.0], 1.0)
    cols = list(zip(*r['z']))
    ranges = [max(c) - min(c) for c in cols]
    return {
        'volatility': round(sum(ranges) / len(ranges), 4) if ranges else 0.0,
        'per_qubit_range': [round(x, 4) for x in ranges],
        'inert_qubits': [q for q, x in enumerate(ranges) if x < 0.05],
    }


def load_stats_cache():
    if os.path.exists(STATS_CACHE):
        try:
            with open(STATS_CACHE) as fh:
                return json.load(fh)
        except Exception:
            pass
    return {}


# ----------------------------------------------------------------------------
# Operations
# ----------------------------------------------------------------------------

def op_worlds(req):
    """Every specification, with its structure and its character."""
    max_q = int(req.get('max_qubits', 7))
    steps = int(req.get('readouts', STEPS))
    cache, dirty = load_stats_cache(), False
    out, skipped = [], []

    for path in sorted(glob.glob(os.path.join(SPEC_DIR, '*.json'))):
        sid = os.path.basename(path)[:-5]
        if sid.startswith('_'):
            continue
        try:
            spec = load(sid)
        except Unusable as e:
            skipped.append({'id': sid, 'why': str(e)})
            continue
        if spec['n'] > max_q:
            skipped.append({'id': sid, 'why': f'out of range (n={spec["n"]})'})
            continue

        info = info_of(spec)
        info['readouts'] = steps
        info['connected'] = len(info['components']) == 1
        info['layers_count'] = len(real_targets(spec)) * steps
        key = f'{sid}@{steps}'
        if key not in cache:
            cache[key] = character(sid, steps)
            dirty = True
        info.update(cache[key])
        out.append(info)

    if dirty:
        try:
            with open(STATS_CACHE, 'w') as fh:
                json.dump(cache, fh, indent=1, sort_keys=True)
        except Exception:
            pass          # a cache that cannot be written is not an error
    return {'worlds': out, 'skipped': skipped}


def op_scout(req):
    """The clean run: what happens with no intervention."""
    r = run(req['circuit'], int(req.get('readouts', STEPS)),
            req.get('direction', [0.0, 0.0, 1.0]),
            float(req.get('coherence', 1.0)))
    return {'info': r['info'], 'cuts': r['cuts'], 'n_layers': r['n_layers'],
            'z': r['z'], 'layers': r['layers']}


def op_play(req):
    """Couple at invest_at and hold. Also returns what the qubit came back as."""
    r = run(req['circuit'], int(req.get('readouts', STEPS)),
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
