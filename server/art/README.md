# Art

One file per name a sequence references. `art: himbo` looks for `himbo.*` here —
`.png`, `.jpg`, `.jpeg` or `.webp`, first match wins.

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

Telegram scales a photo to the chat width, so anything much over 1280px wide is
bytes for nothing. Keep them under a megabyte or two.
