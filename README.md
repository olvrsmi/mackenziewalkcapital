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
| `60` | 24 real minutes | current setting — a readout a minute |
| `1440` | 60 real seconds | fast testing |

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
| `i` / `o` | invest at this readout, or observe on |
| `l` | leave a world, before anything is committed |
| `b` `s` `l` | buy, sell, leave the marketplace |

Once a stake is placed, readouts come due on the game clock — every
`MW_READOUT_GAME_SECONDS` of game time — while reports post every `MW_POST_MS`
of real time, aligned to the clock so every player hears at the same moment. One
report can therefore cover several readouts, or none.

You choose where to take profit when you open a position; it closes there and
the round ends. Leaving a world is free only before you have observed anything.

## Writing

Every word a player reads lives in `server/copy.yaml` — messages, button labels,
world names, the complexity vocabulary, plot captions. No code needs touching to
change any of it, and the bot re-reads the file on save, so an edit shows up in
the next message without a restart or losing anyone's position.

Values arrive already formatted: `{balance}` is `1,000G`, `{coherence}` is
`0.999`. Each entry is commented with what it may use. When prose needs to bend
there are escape hatches — `{n} opportunit{n|s:y:ies}`, `{#if recovering} …
{/if}`, `{balance_raw|money}` — but ordinary lines need none of them. Anywhere a
list is given, one line is picked at random.

```
npm run copy-check
```

checks both directions: that every key the code asks for exists, and that every
`{placeholder}` is one the engine actually supplies. It plays a round with a
recording renderer, so it tests what the game really passes rather than a
hand-kept list. A missing key or bad filter degrades one message and logs; it
never stops a round.

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
