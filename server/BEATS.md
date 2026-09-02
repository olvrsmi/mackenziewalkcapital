# Writing beats

Beats live in `server/copy.yaml`, under `beats:`. Nothing else needs touching to
add one, and the file hot-reloads — a running bot picks up an edit without a
restart.

## A setpiece

Keyed to a day of the probation week, fires once ever when that day begins.

```yaml
beats:
  schedule:
    1: arrival          # day 1 fires the beat named `arrival`
    3: the_oldhead
    6: the_himbo

  arrival: |
    **A hand you don't shake.**

    {budget} of the firm's money is on the desk in front of you.
```

A day with no `schedule` entry passes without a beat. A beat that is just text
can be a bare string, as above.

## With choices

```yaml
  the_oldhead:
    text: |
      **The oldhead stops at your desk.**
      "You're couplin' on the open. Everyone does, first week."
    choices:
      a:
        label: Ask what he'd do
        reply: |
          "Wait for the second print."
        coherence: 0.04
      b:
        label: Say nothing
        reply: |
          He nods once and goes.
```

The **key** (`a`, `b`) is the token the player replies with, and the `label` is
what the button says. Choices are keyed rather than listed so `copy-check` can
see inside them — a list of choices would ship unvalidated.

Choices colour the reply and nothing else. There is no branching and no flags:
the player picks, the beat answers, and the game is exactly where it was.

## Effects

Two, and they may sit on a choice or on the beat itself (on the beat, they apply
however the player answers):

| | |
|---|---|
| `coherence: 0.04` | a delta on the player's qubit, clamped to 0…1 |
| `unlock: steadier_hand` | adds an id to `S.unlocked` |

`unlock` records the id and nothing more — the marketplace does not yet gate on
it, so an unlock is a note for later rather than a working reward today.

Beats deliberately cannot grant money. If one should, say so and it is one line.

## Repeat attempts

A setpiece fires **once ever**, not once per attempt — so a player who fails
probation and starts again would hear nothing. `again` is the answer: short
lines, picked at random, for a floor that carries on without you.

```yaml
  again:
    - _Nobody looks up when you sit down._
    - _A cleaner works around you without asking you to move._
```

## What a beat can interrupt

Nothing. A beat may arrive mid-position — the readouts keep coming — and its
choice can be answered whenever, including days later. A command that is not one
of its choices reaches the game untouched, so a pending beat can never swallow a
`state` or an `invest`.

## Placeholders available

`{day}` the day of the week, 1-based · `{budget}` today's budget · `{attempt}`
which attempt this is. A choice's `reply` also gets `{coherence}`, after its own
effect has applied.

## Checking

```bash
npm run copy-check      # every key a writer typed, validated both ways
npm test                # the beat mechanics
npm run dryrun          # play a round and watch the day-one beat arrive
```
