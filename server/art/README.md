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

## Checking

`npm run copy-check` reads every scene and beat against this directory and
reports both directions — a name with no file, and a file no scene asks for.
Neither is an error: a scene is meant to be writable before it is drawn, and a
picture may sit here waiting for a scene to want it.

## How stills travel

As stickers, not photos. Scene art is cut out of its background, and a photo is
the wrong envelope: Telegram fits a photo to the width of the message column, so
a portrait either stretches or gets a blurred copy of itself painted in behind
it - and the cut-out is exactly what that ruins. A sticker is the one kind
Telegram neither fits to the column nor pads, and it keeps the alpha channel.

Nothing needs preparing. Drop in a PNG at whatever size and `stickerOf` converts
it on the way out: 512 on the long side, WebP, transparency intact, cached in
memory against the file's mtime. That conversion is not a nicety - sendSticker
takes `.WEBP`, `.TGS` or `.WEBM` on upload, so a PNG would be refused, and the
format wants one side to be exactly 512.

An mp4 or a gif still goes through `sendAnimation`, unchanged.

Two things worth knowing:

- **Stickers cannot carry a caption.** The line already travelled as its own
  message after the picture, so nothing changes, but it is now forced rather
  than chosen.
- **The failure is silent.** Hand canvas an image that has not finished
  decoding and it returns a valid, correctly sized, completely empty WebP.
  `npm test` weighs every still before and after converting, because weight is
  the only thing that tells you.
