# Third-party code and data

This repository vendors two external projects so it runs without a fetch step.
Both are redistributed under their own terms, which travel with them.

## QuantumGraph — `model/quantumgraph/`

Copyright IBM Quantum 2020, Copyright Moth Quantum 2025-2026.
Licensed under the Apache License, Version 2.0 — see
`model/quantumgraph/LICENSE`.

Upstream: https://github.com/moth-quantum/QuantumGraph

Copied verbatim; no modifications. The Apache licence requires that modified
files carry a notice saying so, so if you do change anything under that
directory, add one.

## QASMBench — `model/circuits/qasmbench_small/`

Copyright Battelle Memorial Institute. BSD-style licence — see
`model/circuits/qasmbench_small/LICENSE`, which permits redistribution
provided the copyright notice and conditions are retained.

Upstream: https://github.com/pnnl/QASMBench

The 42 `.qasm` files from the suite's `small/` directory, unmodified. Of these,
31 are usable here; the rest are rejected at load time for mid-circuit
measurement, unparseable QASM, or being outside the size range. `engine.py`
reports why for each.

## Everything else

`model/engine.py`, `server/` and the documentation are original to this
repository. The npm dependencies (`grammy`, `@napi-rs/canvas`) are MIT-licensed
and pulled at install time rather than vendored. **No licence has been chosen for them yet** — pick one before
making the repository public, or it is all-rights-reserved by default.
