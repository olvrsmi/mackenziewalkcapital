# Art

One file per name a sequence references. `art: himbo` looks for `himbo.*` here.

**Stills**: `.png`, `.jpg`, `.jpeg`, `.webp` — sent as a photo.
**Moving**: `.mp4` or `.gif` — sent as an animation, which Telegram plays muted
and looping.

An mp4 **must have no audio track**. `sendAnimation` is defined as H.264 without
sound; with an audio stream Telegram sends a video instead — a play button and a
tap, rather than something that loops quietly behind a line of dialogue. The dry
run names any file that has one:

```
ffmpeg -i in.mp4 -an -c:v copy out.mp4
```

A moving version **wins** over a still of the same name, so dropping `himbo.mp4`
beside an existing `himbo.png` upgrades that scene without deleting anything.
Take the mp4 away and it falls back to the still.

**A name with no file is skipped silently.** A scene plays without its pictures,
so scripts can be written before anything is drawn. The dry run says which names
it could not find, so nothing goes missing quietly during development.

Names the intro currently asks for:

| name | what it is |
|---|---|
| `tower` | the outside of the skyscraper |
| `himbo` | the himbo, portrait |
| `lift_closed` | a closed lift and its button |
| `lift_opening` | the lift doors opening |

Also wanted by the beats, when they are written: `oldhead`, and interiors for
the lift, the office and a terminal.

A picture is sent as its own message and its line follows separately, so a small
portrait is never stretched to the width of the text beside it.

Telegram scales media to the chat width, so anything much over 1280px wide is
bytes for nothing. Keep stills under a megabyte or two; an mp4 wants to be
short, silent and small — a few seconds and well under 10MB.
