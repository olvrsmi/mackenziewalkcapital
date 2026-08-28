# Office 4B, 6 Mackenzie Walk — Telegram

A Telegram bot prototype of the intervention game. You carry one qubit; each
world is a quantum circuit you may enter. Pick a moment, couple your qubit to
one of theirs, and stake money on that qubit's ⟨Z⟩ moving in your favour.

```
mackenziewalk_03/
  model/     QuantumGraph + engine.py — the physics, spoken as JSON over stdio
  server/    grammY bot, game rules, server-side PNG rendering, per-chat state
```

Many people can play at once; each Telegram chat is its own saved game.

## Setup

```
python3 -m venv model/.venv                          # needs Python 3.10.13+
model/.venv/bin/pip install -r model/requirements.txt

cd server && npm install
cp .env.example .env                                 # paste your BotFather token
npm start
```

`model/.venv` is found automatically; otherwise `python3` on PATH is used and
`MW_PYTHON` overrides both. Note that qiskit fails on some Python patch releases
— pyenv 3.10.7 raises a `TypeError` inside `qiskit.passmanager` on import where
3.10.13 is fine. The bot reports this specifically if it happens.

Without a token, `npm run dryrun` plays a full round in the terminal, rendering
every image, so the rules and the visuals can be worked on without Telegram.

## Time

The economy runs in **game time**, and `MW_TIME_SCALE` sets how fast that
passes:

| scale | a game day is | use |
|---|---|---|
| `1` | 24 real hours | the intended cadence |
| `3` | 8 real hours | three game days per real day |
| `1440` | 60 real seconds | testing |

Coherence regenerates over about eight game hours and subscriptions bill per
game day, so an overnight absence restores a meaningful amount and costs a
sensible number of G. The browser prototype ran on raw wall-clock seconds, which
only worked for a ten-minute sitting: at those rates, eight hours away billed a
twenty-unit subscription 9,600G against a 1,000G balance.

## Playing

Choices appear as inline buttons, and every button sends the same short token
you could type instead — so free text keeps working, ready for an LLM to sit in
front of it later.

| | |
|---|---|
| `/start` | begin, or start over |
| `/status` `/market` `/time` `/help` | standing, marketplace, clock, commands |
| `1` `2` `3` | enter one of the three worlds on offer |
| `i` / `w` | invest at this readout, or watch on |
| `b` `s` `t` `l` | buy, sell, wait, leave the marketplace |

Once a stake is placed the circuit runs one readout every 15 seconds
(`MW_STEP_MS`), each arriving as its own message with a fresh plot.

## How the pieces fit

`model/engine.py` answers three ops on stdin — `worlds`, `scout`, `play` — and
exits.

`server/game.mjs` holds the rules and no timers: a handler that wants to be
called back returns `{schedule:{kind,ms}}`. `sessions.mjs` owns the clocks,
keyed by chat. A handler returning *no* schedule must never cancel a pending
one, or a player typing during their own run would stop it dead.

`render.mjs` draws the plots server-side with `@napi-rs/canvas` and hands
Telegram a PNG buffer. Captions stay ASCII — the bundled font renders `⟨Z⟩` and
box-drawing glyphs as tofu.

Messages are sent as HTML, not MarkdownV2, whose escaping rules trip over
circuit ids like `grover_n2` and values like `-1.000`.

## Third-party code

`model/quantumgraph/` (Apache 2.0) and `model/circuits/qasmbench_small/`
(BSD-style) are vendored from upstream projects. See [NOTICE.md](NOTICE.md).
