# Writing beats and scenes

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

---

# Scenes

A **sequence** is a scripted scene: a list of nodes played in order, stopping
wherever it wants something from the player. Everything up to that stop is sent
in one burst, a beat apart, with a typing indicator — so it reads as someone
talking rather than as four messages at once. `MW_PACE_MS` sets the gap.

They live under `sequences:` in `copy.yaml`. `intro` plays at a first `/start`,
in place of `scenes.welcome`. `tutorial` is there and empty; an empty sequence
simply does not play, so it can sit unfinished.

## A node

```yaml
sequences:
  intro:
    - art: tower                      # picture alone

    - art: himbo                      # picture and a line, as one message
      speaker: Himbo
      text: |
        There you are, you made it past security.

    - art: lift_closed                # stops here and waits
      choices:
        a:
          label: Call the lift
          art: himbo
          speaker: Himbo
          reply: |
            Whoa ok we got an ambitious one.
        b:
          label: Do nothing
          speaker: Himbo
          reply: |
            _Presses lift button_

    - speaker: Himbo                  # both branches arrive here
      text: |
        You golf?
```

| field | |
|---|---|
| `art` | a name in `server/art/`. Missing files are skipped, so write before it is drawn |
| `speaker` | who is talking; rendered bold above the line |
| `text` | what they say |
| `choices` | keyed `a`, `b`, `c`… — **any number**. Each has a `label` and a `reply` |
| `ask` | capture what the player types next into a named variable |

Choices **colour the moment and rejoin**: the reply plays, then the sequence
carries on from the next node. There is no branching to track and no graph to
hold in your head.

## Asking the player something

```yaml
    - speaker: Himbo
      text: What do we call you?
      ask: name
    - speaker: Himbo
      text: |
        Alright, {name}. This way.
```

Whatever they type is stored (trimmed, 60 characters) and readable as `{name}`
in every later line of every scene, and in beats.

## Effects

The same two a beat may carry, on a choice or an `ask`: `coherence:` as a delta
and `unlock:` as a marketplace id.

## Placeholders

`{budget}`, `{coherence}`, and anything an earlier `ask` captured.

## What a scene interrupts

Everything. A running scene has the floor: a command it does not recognise gets
*"Someone is still talking"* rather than reaching the game, so a player cannot
be halfway up the lift and holding a position. `skip` ends it — which also skips
the welcome, since the scene is in place of it. `help` is where the rules live.

This is the opposite of a beat, which must never swallow a command.
