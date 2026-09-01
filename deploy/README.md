# Deploying

Four scripts and three systemd units. `setup.sh` builds a box from nothing,
`deploy.sh` moves it to a commit, `preflight.sh` proves the result works,
`backup.sh` runs nightly on a timer.

None of this has been run against a real Hetzner box. The logic is exercised
locally — `preflight.sh` passes against a working checkout — but the first run
on a fresh machine will find something, most likely in the Python install.

## Once

Create the box (Ubuntu 24.04, **CX22** — 2 vCPU / 4GB / 40GB is comfortable;
2GB works but leaves nothing spare when several people act at once), then:

```
ssh -i ~/.ssh/your-key root@your.box 'bash -s' < deploy/setup.sh
```

That is self-contained: it clones this repository itself, installs Node 22 and
a Python venv, creates an unprivileged `mw` user, installs the Node
dependencies, registers the services, and turns on a firewall that allows only
SSH.

It does **not** install the QDrive engine, which lives in two private
repositories — `moth-quantum/qdrive-api` and `moth-quantum/QDrive`. They cannot
be vendored here, because this repository is public; and they are not cloned on
the box either, because that would need deploy keys on repositories we do not
administer. `deploy.sh` sends a checkout of each from a machine that already has
them, which needs no permission anywhere. So `setup.sh` leaves a note and moves
on, and the first `deploy.sh` completes the box.

It leaves an empty `.env` for you to fill in:

```
ssh -i ~/.ssh/your-key root@your.box nano /opt/mackenziewalk/app/server/.env
```

Put the **deployed** bot's token in it — not the development one. Then check
the box before trusting it, and start:

```
ssh -i ~/.ssh/your-key root@your.box /opt/mackenziewalk/app/deploy/preflight.sh
ssh -i ~/.ssh/your-key root@your.box systemctl start mackenziewalk
```

## Every time after

The box pulls from GitHub, so **push first**:

```
git push
./deploy/deploy.sh -i ~/.ssh/your-key root@your.box
```

That moves the box to your current branch's head, reinstalls anything whose
dependencies changed, checks the model still answers, restarts, and prints the
status. It refuses to run if what you are asking for is not on GitHub yet,
rather than silently deploying something older.

```
-i PATH        ssh identity file, same as ssh's own (or set MW_SSH_KEY)
--ref v0.2     a tag, branch or commit instead of the current branch
--no-deps      only game code changed, skip the installs
--no-engine    only game code changed, skip sending QDrive
--dry-run      say what would happen, change nothing
```

Because the box is always at a named commit, `git log --oneline -1` there tells
you exactly what your playtesters are on.

### If the repository goes private again

`setup.sh` clones over HTTPS and will fail on a private repository. Either add
a read-only **deploy key** for *this* repository to the box and set
`MW_REPO=git@github.com:olvrsmi/mackenziewalkcapital.git`, or use a fine-grained
token in the URL. Nothing else changes.

### Keys

Every command here takes `-i`, the same as `ssh` itself. Set `MW_SSH_KEY` once
instead if you would rather not repeat it:

```
export MW_SSH_KEY=~/.ssh/your-key
./deploy/deploy.sh root@your.box
```

`deploy.sh` passes it to both ssh and rsync, with `IdentitiesOnly` so an agent
cannot quietly authenticate with a different key and leave you unsure which one
worked. It checks the file exists and is mode 600 or 400 before starting, rather
than letting ssh refuse it eight commands in.

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
| code | `/opt/mackenziewalk/app` — a git clone, owned by root |
| engine | `/opt/mackenziewalk/vendor/{qdrive-api,QDrive}` — private clones |
| saved games | `/opt/mackenziewalk/state` |
| event log | `/opt/mackenziewalk/logs/events.jsonl` |
| backups | `/opt/mackenziewalk/backups`, nightly, 14 kept |
| service | `mackenziewalk.service`, as user `mw` |
| console | `journalctl -u mackenziewalk` |

Data sits outside the working tree, so `git reset --hard` is never near a saved
game. The clone is root-owned and the game runs as `mw`, so the process cannot
rewrite the code it is running — `ProtectSystem=strict` makes the whole
filesystem read-only to it except `state/` and `logs/`. Python bytecode is
compiled at deploy time, as root, so nothing needs to write at runtime.

The bot polls outward and listens on nothing, so there is no port to open, no
certificate, and no web server.

## Watching it

```
ssh -i $MW_SSH_KEY root@your.box journalctl -u mackenziewalk -f          # live console
ssh -i $MW_SSH_KEY root@your.box systemctl status mackenziewalk          # up? since when?
ssh -i $MW_SSH_KEY root@your.box 'cd /opt/mackenziewalk/app/server && npm run stats -- --file /opt/mackenziewalk/logs/events.jsonl'
```

`npm run stats` reports p50/p95 for every model call, render and turn, plus the
peak number of Python processes alive at once — the figure that sizes the box.
It takes `--since 2h`. To read a log here instead:

```
scp -i $MW_SSH_KEY root@your.box:/opt/mackenziewalk/logs/events.jsonl /tmp/box.jsonl
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
| `worlds` | 0.04s warm — it never loads qiskit |
| `scout` / `play` | 4s at two qubits, 9s at seven |
| render | 16ms, 34KB |

Python runs **per round, not per readout** — the whole ten-step run is computed
when the world is scouted and again when the position opens. So cost follows how
often people *start* rounds, not how long they hold, but each of those is now
several seconds rather than half of one: a step is a whole job, and there are
ten of them.

The world characters in `model/specs/_stats_cache.json` are committed for that
reason. Building them from cold is 108 seconds, and the code directory is
read-only at runtime, so the box could neither afford it nor save the result.

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
- **The engine is sent from a laptop, not fetched.** What runs on the box is
  whatever was checked out in `MW_VENDOR_SRC` at deploy time, and nothing on
  the box records which commit that was. `deploy.sh` prints it; if it matters,
  keep the note.
- **Python version.** The QDrive engine declares 3.12 or newer, and qiskit does
  not import at all on 3.10.7. Ubuntu 24.04 ships 3.12, which is fine, but
  `preflight.sh` checks the version *and* imports every module rather than
  trusting either.
- **`engine.py` shims a seeding bug** in qdrive-api's `backend.py`: the
  estimator's seed is passed as `backend_options`, which AerEstimator ignores,
  so jobs are not reproducible. The shim sets `run_options.seed_simulator`
  instead. `model/selftest.py` fails if it ever stops working.
- **`curl | bash`** installs Node from NodeSource. It is their documented
  method; swap it for `apt install nodejs` if you would rather have Ubuntu's
  older Node.
- **Logs contain chat ids**, same as the saved games. Treat them alike.
