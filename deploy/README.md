# Deploying

Four scripts and three systemd units. `setup.sh` prepares a box, `deploy.sh`
pushes code to it, `preflight.sh` proves the result works, `backup.sh` runs
nightly on a timer.

None of this has been run against a real Hetzner box. The logic is exercised
locally — `preflight.sh` passes against a working checkout — but the first run
on a fresh machine will find something, most likely in the Python install.

## Once

Create the box (Ubuntu 24.04, **CX22** — 2 vCPU / 4GB / 40GB is comfortable;
2GB works but leaves nothing spare when several people act at once). Then, from
this repository:

```
./deploy/deploy.sh root@your.box --setup
```

That copies the code, installs Node 22 and a Python venv, creates an
unprivileged `mw` user, registers the services, and turns on a firewall that
allows only SSH. It leaves an empty `.env` at `/opt/mackenziewalk/server/.env`.

Put the **deployed** bot's token in it — not the development one:

```
ssh root@your.box nano /opt/mackenziewalk/server/.env
```

Then check the box before trusting it, and start:

```
ssh root@your.box /opt/mackenziewalk/deploy/preflight.sh
ssh root@your.box systemctl start mackenziewalk
```

## Every time after

```
./deploy/deploy.sh root@your.box
```

Copies the working tree, reinstalls anything whose dependencies changed,
restarts, and prints the status. `--no-deps` skips the installs when only code
changed; `--dry-run` shows what would be sent.

The repository is private, so this ships the working copy over SSH rather than
cloning — no deploy key on the box, and no need to push before trying
something. The tradeoff is that the box can drift from git, so `deploy.sh`
tells you when what you are sending is not what is committed.

`.env`, `state/`, `events.jsonl` and the backups live on the box and are never
overwritten or deleted by a deploy.

## Two bots, always

Telegram allows exactly **one long poll per token**, and a second one *evicts*
the first — the loser exits. This is the constraint that shapes everything:

- The box uses `TELEGRAM_BOT_TOKEN`. Your laptop uses
  `TELEGRAM_BOT_TOKEN_LOCAL` via `npm run dev`. Never the same token twice.
- Every deploy is a hard cutover. There is no overlap and no blue/green.
- You cannot run two instances for redundancy or load. That needs webhooks and
  shared state, which is a different program.

`preflight.sh` fails if it finds the development token in the box's `.env`,
because that mistake takes the game down rather than erroring loudly.

## What runs where

| | |
|---|---|
| code | `/opt/mackenziewalk` |
| saved games | `/opt/mackenziewalk/server/state` |
| event log | `/opt/mackenziewalk/server/events.jsonl` |
| backups | `/opt/mackenziewalk/backups`, nightly, 14 kept |
| service | `mackenziewalk.service`, as user `mw` |
| console | `journalctl -u mackenziewalk` |

The bot polls outward and listens on nothing, so there is no port to open, no
certificate, and no web server.

## Watching it

```
ssh root@your.box journalctl -u mackenziewalk -f          # live console
ssh root@your.box systemctl status mackenziewalk          # up? since when?
ssh root@your.box 'cd /opt/mackenziewalk/server && npm run stats'
```

`npm run stats` reads `events.jsonl` and reports p50/p95 for every model call,
render and turn, plus the peak number of Python processes alive at once —
which is the figure that sizes the box. It takes `--since 2h`. To read a log
here instead:

```
scp root@your.box:/opt/mackenziewalk/server/events.jsonl /tmp/box.jsonl
npm --prefix server run stats -- --file /tmp/box.jsonl
```

Look for `SAVE LOST` (a player silently started again), `POLLING STOPPED` (a
409, so something else took the token), and the restart count.

## When it stops

`Restart=always` covers the ordinary case — the canvas library panics in Rust
on bad input, which aborts the process rather than raising something catchable,
and sessions mid-run are picked back up on boot.

Two deliberate exceptions, via `RestartPreventExitStatus=78`:

- **a missing or rejected token** — configuration, not a crash
- **a 409** — another poller holds the token, and restarting only fights it

Both stop the service cleanly. `systemctl status` says which. A genuine crash
loop trips `StartLimitBurst=5` after five restarts in five minutes and stops
too, rather than hammering Telegram.

## Time

`MW_TIME_SCALE` on the box is **24**: a game day per real hour, a round about
eighteen minutes, so someone who drops in for an hour sees three rounds and a
day close. Posting is derived from it — there is nothing else to set.

## Sizing, and what breaks first

Measured, not estimated:

| | |
|---|---|
| node | ~163MB resident |
| python per call | 100MB, 165MB for `worlds` |
| `worlds` | 1.7s, on boot and after a restart |
| `scout` / `play` | ~0.5s |
| render | 16ms, 34KB |

Python runs **per round, not per readout** — the whole run is precomputed when
the position opens. So cost follows how often people *start* rounds, not how
long they hold. Five players acting at once is five Python processes, about
800MB, for a second.

The first wall is Telegram, not the box. Readouts post aligned to the wall
clock, so every active player is messaged in the same instant. Per-chat limits
are about one message a second and thirty a second overall, so that fan-out
becomes the constraint somewhere in the low hundreds of players — long before
CPU does.

## Known risks

- **Nothing here has touched a real box.** Expect the first run to find
  something.
- **ARM (CAX-series) is untested.** `qiskit-aer` and `@napi-rs/canvas` both
  ship prebuilt binaries per architecture; `preflight.sh` checks the canvas
  one specifically. Cheaper, but verify before committing to it.
- **`pairwise-tomography` installs from a GitHub URL**, so a deploy needs `git`
  and reachable GitHub. It is the likeliest install failure.
- **Python version.** qiskit does not import on 3.10.7. Ubuntu 24.04 ships
  3.12, which is fine, but `preflight.sh` imports qiskit rather than trusting
  the version string.
- **`curl | bash`** installs Node from NodeSource. It is their documented
  method; swap it for `apt install nodejs` if you would rather have Ubuntu's
  older Node.
- **Logs contain chat ids**, same as the state directory. Treat them alike.
