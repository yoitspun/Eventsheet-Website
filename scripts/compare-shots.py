#!/usr/bin/env python3
"""Compare screenshots from two browser-check.mjs runs (live vs local).

Usage: python3 scripts/compare-shots.py <live-dir>/shots <local-dir>/shots [--diff-dir out]

Prints, per screenshot, whether the page heights match and the share of pixels
that differ noticeably. Animated elements (tickers, videos, Rive) always differ a
little, so look at the worst pages by eye using the diff images.
"""

import argparse
import os

import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("live")
ap.add_argument("local")
ap.add_argument("--diff-dir")
ap.add_argument("--threshold", type=int, default=40, help="per-channel delta that counts as a changed pixel")
args = ap.parse_args()

rows = []
for name in sorted(os.listdir(args.live)):
    other = os.path.join(args.local, name)
    if not os.path.exists(other):
        rows.append((name, None, None, None, "missing locally"))
        continue
    a = Image.open(os.path.join(args.live, name)).convert("RGB")
    b = Image.open(other).convert("RGB")
    h = min(a.height, b.height)
    w = min(a.width, b.width)
    da = np.asarray(a.crop((0, 0, w, h)), dtype=np.int16)
    db = np.asarray(b.crop((0, 0, w, h)), dtype=np.int16)
    changed = (np.abs(da - db).max(axis=2) > args.threshold)
    pct = 100.0 * changed.mean()
    rows.append((name, a.size, b.size, pct, ""))
    if args.diff_dir and pct > 0.5:
        os.makedirs(args.diff_dir, exist_ok=True)
        overlay = np.asarray(b.crop((0, 0, w, h))).copy()
        overlay[changed] = [255, 0, 255]
        Image.fromarray(overlay).save(os.path.join(args.diff_dir, name), quality=80)

rows.sort(key=lambda r: -1 if r[3] is None else r[3], reverse=True)
for name, sa, sb, pct, note in rows:
    if pct is None:
        print(f"{'':>8}  {name}  {note}")
        continue
    size_note = "" if sa == sb else f"  size live={sa} local={sb}"
    print(f"{pct:7.2f}%  {name}{size_note}")
