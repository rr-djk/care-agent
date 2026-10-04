#!/usr/bin/env python3
"""Zones per layout (template geometry) from data/ground_truth.json and data/masks.json.

A zone is one rectangle cropped and sent to the model in one call. Its `cells` are
in the order of the compact ZoneAnswer (packages/schema): tables row by row, then
left to right. Cells are the template slots, so they exist even where a patient left
them empty. Checkboxes stay in their zone with kind "checkbox" (read by ink density).
Identifier fields have no cell; their areas are listed in `masks` so a cropper can blank them.

Template geometry = patient 1's page (the least skewed one) plus, for handwriting that
sits outside every printed slot, the union of the boxes seen on all patients.

Writes data/zones/<layout>.json for pages 1 (cover, step 11), 2, 3, 4, 5/7 and 6/8 (step 12).
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
TEMPLATE_PATIENT = 1
MAX_TEXT_CELLS = 24

# Pregnancy visit table, 30 rows: no zone may cross a dark section band (the band confused the reading of the rows next to it).
# Sections: visits 4 rows | EXAMEN CLINIQUE 13 | EXAMEN BIOLOGIQUE 11 | TRAITEMENT 1 (Fer) | EXAMEN FAIT PAR 1.
PREGNANCY_ROW_GROUPS = [4, 7, 6, 6, 5, 1, 1]

# Per layout: (zone name, (y0, y1) band in page fractions, rows per zone, columns per zone, pad).
# rows/cols None = everything in the band is one zone. pad = (left, right, top, bottom) in page fractions added
# around the cells so the crop shows the printed labels and headers; in split tables only the first
# column group gets the left pad (row labels) and the first row group the top pad (column headers).
PLANS = {
    "cover": (1, [
        ("identity", (0, 0.25), None, None, (0.1, 0.02, 0.012, 0.008)),
        ("facility", (0.25, 0.45), None, None, (0.08, 0.1, 0.03, 0.01)),
        ("risk", (0.45, 1), None, None, (0.05, 0.1, 0.02, 0.01)),
    ]),
    "identification": (2, [
        ("identity", (0, 0.235), None, None, (0.09, 0.02, 0.01, 0.008)),
        ("antecedents", (0.235, 0.42), None, None, (0.15, 0.02, 0.02, 0.01)),
        ("obstetric", (0.42, 0.56), None, None, (0.19, 0.01, 0.022, 0.005)),
        ("deliveries", (0.56, 0.84), 3, None, (0.19, 0.01, 0.05, 0.003)),
        ("history", (0.84, 1), None, None, (0.09, 0.09, 0.01, 0.01)),
    ]),
    "pregnancy": (3, [
        ("header", (0, 0.145), None, None, (0.09, 0.09, 0.01, 0.008)),
        ("visits", (0.145, 1), PREGNANCY_ROW_GROUPS, 3, (0.19, 0.003, 0.036, 0.003)),
    ]),
    "delivery": (4, [
        ("place", (0, 0.33), None, None, (0.02, 0.1, 0.01, 0.01)),
        ("mode", (0.33, 0.57), None, None, (0.17, 0.07, 0.01, 0.01)),
        ("complications", (0.57, 0.78), None, None, (0.05, 0.1, 0.01, 0.01)),
        ("newborn", (0.78, 1), None, None, (0.05, 0.1, 0.01, 0.01)),
    ]),
    "postpartum_mother": (5, [
        ("header", (0, 0.145), None, None, (0.36, 0.03, 0.012, 0.01)),
        ("vitals", (0.145, 0.18), None, None, (0.03, 0.02, 0.012, 0.008)),
        ("state", (0.18, 0.365), None, None, (0.04, 0.12, 0.012, 0.01)),
        ("exam", (0.365, 0.46), None, None, (0.04, 0.12, 0.012, 0.01)),
        ("complications", (0.46, 0.6), None, None, (0.04, 0.12, 0.012, 0.01)),
        ("followup", (0.6, 0.7), None, None, (0.03, 0.2, 0.012, 0.01)),
        ("contraception", (0.7, 1), None, None, (0.02, 0.2, 0.012, 0.01)),
    ]),
    "postpartum_newborn": (6, [
        ("measures", (0, 0.175), None, None, (0.04, 0.03, 0.012, 0.008)),
        ("signs", (0.175, 0.35), None, None, (0.02, 0.09, 0.012, 0.008)),
        ("lesions", (0.35, 0.51), None, None, (0.02, 0.1, 0.012, 0.01)),
        ("vaccines", (0.51, 0.67), None, None, (0.02, 0.1, 0.012, 0.01)),
        ("decision", (0.67, 1), None, None, (0.02, 0.03, 0.012, 0.01)),
    ]),
}

# Pages 5 and 7 print different options in the header ("7ème et 8ème jour" / "40ème et 50ème jour") at other
# positions: the layout template also holds the slots of the later page that the first page lacks.
EXTRA_TEMPLATE_PAGE_TYPE = {"postpartum_mother": 7}


def cluster(values, tol):
    """Indices of the clusters (sorted by value) each value belongs to."""
    order = sorted(set(values))
    groups = []
    for v in order:
        if groups and v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return {v: i for i, g in enumerate(groups) for v in g}


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def center(b):
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def chunks(n, size):
    if isinstance(size, list):  # explicit row counts, one per zone
        assert sum(size) == n, f"row groups {size} do not cover {n} rows"
        ends = [sum(size[: i + 1]) for i in range(len(size))]
        return list(zip([0] + ends[:-1], ends))
    return [(i, min(i + size, n)) for i in range(0, n, size)] if size else [(0, n)]


def build_layout(layout, page_type, slots, masks):
    templ = slots
    zones = []
    for name, (y0, y1), rows_per, cols_per, pad in PLANS[layout][1]:
        cells = [s for s in templ if y0 <= center(s["bbox_frac"])[1] < y1]
        if not cells:
            continue
        # Reading order: row clusters, then x. Two side-by-side tables are read left block first.
        rows = cluster([round(center(s["bbox_frac"])[1], 4) for s in cells], 0.006)
        cols = cluster([round(center(s["bbox_frac"])[0], 4) for s in cells], 0.012)
        for s in cells:
            cx, cy = center(s["bbox_frac"])
            s["_row"], s["_col"] = rows[round(cy, 4)], cols[round(cx, 4)]
        block = (lambda s: center(s["bbox_frac"])[0] > 0.5) if name == "antecedents" else (lambda s: 0)
        cells.sort(key=lambda s: (block(s), s["_row"], s["_col"]))
        n_rows, n_cols = max(rows.values()) + 1, max(cols.values()) + 1
        for ri, (ra, rb) in enumerate(chunks(n_rows, rows_per)):
            for ci, (ca, cb) in enumerate(chunks(n_cols, cols_per)):
                group = [s for s in cells if ra <= s["_row"] < rb and ca <= s["_col"] < cb]
                if not group:
                    continue
                zid = f"p{page_type:02d}.{name}" + (f".r{ri + 1}c{ci + 1}" if rows_per or cols_per else "")
                split = bool(rows_per or cols_per)
                l, r, t, b = pad
                x0, y0b, x1, y1b = union([s["bbox_frac"] for s in group])
                box = [x0 - (l if ci == 0 or not split else 0), y0b - (t if ri == 0 or not split else 0), x1 + r, y1b + b]
                box = [round(min(max(v, 0), 1), 4) for v in box]
                zones.append(dict(id=zid, bbox_frac=box,
                                  cells=[dict(key=s["key"], kind=s["kind"], bbox_frac=s["bbox_frac"]) for s in group]))
    return dict(layout=layout, page_type=page_type, template_page=(TEMPLATE_PATIENT - 1) * 8 + page_type,
                masks=masks, zones=zones)


def dump(out):
    """One zone per block, one cell per line."""
    j = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    head = {k: v for k, v in out.items() if k != "zones"}
    zones = []
    for z in out["zones"]:
        cells = ",\n".join("   " + j(c) for c in z["cells"])
        zones.append(f'  {{"id":{j(z["id"])},"bbox_frac":{j(z["bbox_frac"])},"cells":[\n{cells}]}}')
    return j(head)[:-1] + ',\n "zones":[\n' + ",\n".join(zones) + "]}\n"


def main():
    gt = json.loads((DATA / "ground_truth.json").read_text())
    masks = json.loads((DATA / "masks.json").read_text())
    (DATA / "zones").mkdir(exist_ok=True)
    for layout, (page_type, _) in PLANS.items():
        page_no = (TEMPLATE_PATIENT - 1) * 8 + page_type
        slots = [dict(s) for s in gt[str(page_no)]["slots"]]
        if layout in EXTRA_TEMPLATE_PAGE_TYPE:
            have = {s["key"] for s in slots}
            later = gt[str((TEMPLATE_PATIENT - 1) * 8 + EXTRA_TEMPLATE_PAGE_TYPE[layout])]["slots"]
            slots += [dict(s) for s in later if s["key"] not in have]
        out = build_layout(layout, page_type, slots, masks[layout])
        placed = {c["key"] for z in out["zones"] for c in z["cells"]}
        missing = [s["key"] for s in slots if s["key"] not in placed]
        if missing:
            raise SystemExit(f"{layout}: slots outside every zone: {missing}")
        (DATA / "zones" / f"{layout}.json").write_text(dump(out))
        text = [sum(c["kind"] == "text" for c in z["cells"]) for z in out["zones"]]
        print(f"{layout}: {len(out['zones'])} zones, max cells {max(len(z['cells']) for z in out['zones'])}, "
              f"max text cells {max(text)}, cells {sum(len(z['cells']) for z in out['zones'])}")
        assert max(text) <= MAX_TEXT_CELLS, "zone has too many text cells"


if __name__ == "__main__":
    main()
