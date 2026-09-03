# tools/ — the blur bench

A page for tuning the quantum blur that goes over a chart. The effect itself
lives in [`../server/blur.mjs`](../server/blur.mjs) and this only drives it, so
a setting that looks right here is a setting the bot will run.

```bash
cd server && npm run blur-bench     # then open http://localhost:5060
```

The Moth key is read from `../../moth-api/KEY` unless `MW_MOTH_KEY` or
`MW_MOTH_KEY_FILE` says otherwise. It stays on the server: the page posts
settings to localhost, localhost posts images to Moth, and the browser only
ever sees pictures and milliseconds.

## The pipeline

Oliver's Photoshop process, in his order:

| | step | knob |
|---|---|---|
| 1 | duplicate the chart | |
| 2 | downscale to N px on the longest side | **downscale size** |
| 3 | threshold — a hard black-and-white cut | **threshold level** |
| 4 | through Moth's `blur-v2` | **strength · gate · reach · budget** |
| 5 | back to full size, nearest-neighbour | |
| 6 | lay it over the original | **blend mode · opacity · gain** |

Order matters at 2 and 3. Downscaling first means the cut lands on
already-averaged pixels, which is what makes the level so sensitive — and the
sensitivity is the point.

## What a credit buys

One engine run. Blend mode, opacity and gain are all downstream of it, so the
last blur is kept and those three recomposite locally for free — which is why
they update as you drag and everything else waits for the button. The count in
the sidebar is engine runs, not requests.

## The luminosity ruler

Under the threshold slider, every colour the chart uses, in luminosity order,
with a marker at the cut. It answers what the slider is really asking — which
parts of the picture survive — and it reads the renderer's own palette, so it
cannot go stale.

The tight one is `line` at **32**: the gridlines clear a threshold of 28 by
four levels and vanish at 33.

## What the numbers said

A chart is about 95% background, so a thresholded copy is only about **5.4%
white**. The blur is unitary — it moves intensity around rather than adding
any — so spreading that across the whole canvas leaves a mean luminance of 7.7
and only **0.2% of pixels above the midpoint**.

That matters because vivid light brightens what is above the midpoint and burns
everything below it. At 0.2% the overlay can only darken, and the chart goes
almost black. **Overlay gain** is the answer and is why it exists: at 4× the
same blur puts 6.8% above the midpoint and the chart comes back with
interference scattered over it. Gain is not part of the manual process and does
nothing at 1, so the defaults still reproduce Photoshop exactly.

The reading under the gain slider is that number. If a change does not move
"above the midpoint", it will not change the look.

## The chart it tunes against

`fixture.json` — a real ten-step run of `spec_n7_01`, seven holdings, coupled
at step 4. Real rather than invented, because made-up numbers draw a tidier
chart than the game ever does. Regenerate with:

```bash
MW_QDRIVE_API_SRC=../coupling-playground/qdrive-api/src node tools/fixture.mjs
```

## Before this goes on the box

An engine run measured **6.7–7.4 s**, split roughly 2 s registering the asset,
0.7 s submitting, 3.5–3.9 s queued and running, 0.7 s downloading. Local image
work is about 120 ms of it. So a blurred chart is seven seconds and a credit,
against a chart today that is instant and free — the bench shows the split so
that decision can be made on numbers.

```bash
node tools/check.mjs        # or: npm run blur-check
```

Compares the page's knobs against `DEFAULTS` both ways, checks the cache key
leaves the free settings out, and checks the fixture still has seven holdings
and a coupling in the middle. A control that tunes nothing, or a setting with no
control, would make the bench lie about what the box will do.
