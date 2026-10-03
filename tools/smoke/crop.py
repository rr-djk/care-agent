#!/usr/bin/env python3
"""Crop one zone of specimen page 3 (patient 1) for the latency probe.

Usage: crop.py [x0 y0 x1 y1] [out_path]   (pixels of the original image)
Default box: header + first rows of the visit table through "Etat des conjonctives",
first trimester columns (Visites 1-3), ~10 px padding.
"""
import os
import sys
from pathlib import Path

from PIL import Image

here = Path(__file__).resolve().parent
repo = here.parent.parent
datasets = Path(os.environ.get("DATASETS_DIR") or repo.parent / "datasets")
src = datasets / "data" / "Paper Registry" / "dossiers_specimen_10_patientes-03.png"

args = sys.argv[1:]
box = (100, 329, 806, 841)
if len(args) >= 4:
    box = tuple(int(a) for a in args[:4])
    args = args[4:]
out = Path(args[0]) if args else here / "out" / "p03_crop.png"

if datasets.resolve() in out.resolve().parents:
    sys.exit("refusing to write inside the datasets directory")

out.parent.mkdir(parents=True, exist_ok=True)
with Image.open(src) as im:
    crop = im.convert("RGB").crop(box)
crop.save(out)
print(f"{out} {crop.size[0]}x{crop.size[1]} box={box}")
