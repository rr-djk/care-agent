#!/usr/bin/env python3
"""Overlay previews docs/zones-pNN.png: patient 1's clean page (read-only), zones, cells,
and the identifier areas painted black so nothing identifying is published.

Usage: zones_preview.py [--width 1000]
"""
import argparse
import colorsys
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LAYOUTS = ["cover", "identification", "pregnancy", "delivery", "postpartum_mother", "postpartum_newborn"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=1000)
    a = ap.parse_args()
    datasets = Path(os.environ.get("DATASETS_DIR") or REPO.parent / "datasets").resolve()
    out_dir = (REPO / "docs").resolve()
    font = ImageFont.load_default(size=13)
    for layout in LAYOUTS:
        z = json.loads((HERE / "data" / "zones" / f"{layout}.json").read_text())
        src = datasets / "data" / "Paper Registry" / f"dossiers_specimen_10_patientes-{z['template_page']:02d}.png"
        with Image.open(src) as im:
            im = im.convert("RGB")
        w = a.width
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        d = ImageDraw.Draw(im)
        px = lambda b: [b[0] * im.width, b[1] * im.height, b[2] * im.width, b[3] * im.height]
        for m in z["masks"]:
            d.rectangle(px(m), fill="black")
        n = len(z["zones"])
        for i, zone in enumerate(z["zones"]):
            r, g, b = (int(255 * v) for v in colorsys.hsv_to_rgb(i / n, 0.9, 0.75))
            for c in zone["cells"]:
                d.rectangle(px(c["bbox_frac"]), outline=(r, g, b), width=1)
            x0, y0, x1, y1 = px(zone["bbox_frac"])
            d.rectangle([x0 - 3, y0 - 3, x1 + 3, y1 + 3], outline=(r, g, b), width=3)
            label = zone["id"].split(".", 1)[1] + f" ({len(zone['cells'])})"
            tw = d.textlength(label, font=font)
            d.rectangle([x0 - 3, y0 - 18, x0 - 3 + tw + 6, y0 - 3], fill=(r, g, b))
            d.text((x0, y0 - 18), label, fill="white", font=font)
        out = out_dir / f"zones-p{z['page_type']:02d}.png"
        im.quantize(colors=96, method=Image.Quantize.MEDIANCUT).save(out, optimize=True)
        print(f"{out.relative_to(REPO)}: {out.stat().st_size // 1024} KB, {n} zones")


if __name__ == "__main__":
    main()
