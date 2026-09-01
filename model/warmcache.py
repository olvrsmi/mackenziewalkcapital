#!/usr/bin/env python3
"""
model/warmcache.py - compute every world's character and write it to disk.

specs/_stats_cache.json holds the volatility quoted in the prospectus, which is
worked out by running each world once with nobody in it. That takes a couple of
minutes for the whole set, so it is computed here and committed.

It has to be committed, and this is the part worth knowing: the deployed code
directory is read-only, so a box that meets an uncached world recomputes it,
fails to save the result, and does the same again on the next call - on every
boot, and for every player's first move after a restart.

Two things invalidate an entry, and both are easy to do by accident:

    adding or editing a specification
    changing MW_STEPS            (the cache is keyed <id>@<steps>)

So after either, run this and commit what changes:

    MW_STEPS=10 .venv/bin/python3 warmcache.py
"""

import json
import os
import sys
import time

import engine


def main():
    steps = engine.STEPS
    cache = engine.load_stats_cache()
    ids = sorted(
        os.path.basename(p)[:-5]
        for p in __import__('glob').glob(os.path.join(engine.SPEC_DIR, '*.json'))
        if not os.path.basename(p).startswith('_')
    )

    print(f'\n  {len(ids)} specifications at {steps} steps')
    wrote, t0 = 0, time.time()
    for sid in ids:
        key = f'{sid}@{steps}'
        if key in cache and '--force' not in sys.argv:
            print(f'    {sid:16s} cached')
            continue
        t = time.time()
        try:
            cache[key] = engine.character(sid, steps)
        except engine.Unusable as e:
            print(f'    {sid:16s} SKIPPED: {e}')
            continue
        wrote += 1
        print(f'    {sid:16s} {cache[key]["volatility"]:.3f} volatility '
              f'({time.time() - t:.1f}s)')

    stale = [k for k in cache if not k.endswith(f'@{steps}')]
    if stale:
        print(f'\n  {len(stale)} entr{"y" if len(stale) == 1 else "ies"} for other '
              f'step counts left in place')

    with open(engine.STATS_CACHE, 'w') as fh:
        json.dump(cache, fh, indent=1, sort_keys=True)
    print(f'\n  {wrote} computed in {time.time() - t0:.0f}s · '
          f'{engine.STATS_CACHE}')
    if wrote:
        print('  commit specs/_stats_cache.json, or the box will recompute it '
              'on every call\n')
    else:
        print()


if __name__ == '__main__':
    main()
