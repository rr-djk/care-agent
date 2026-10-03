import json
import re
import unittest
from pathlib import Path

from extract_pdf import IDENTIFIER_LABELS, STAFF, abbrev, slug

DATA = Path(__file__).parent / "data"

# What must never appear in a committed output: identifier labels, CIN, phone numbers.
FORBIDDEN = {
    "identifier label": re.compile(r"parturiente|nom[ _]du[ _]mari|adresse|t[eé]l[eé]phone|(?<![a-z0-9])cin(?![a-z0-9])|patiente(?! fictive)", re.I),
    "CIN": re.compile(r"\b[A-Z]{1,2}\d{5,8}\b"),
    "phone": re.compile(r"(?<!\d)0[5-7](?:[ .-]?\d{2}){4}(?!\d)"),
}


def scan(text):
    return [(name, m.group(0)) for name, rx in FORBIDDEN.items() for m in rx.finditer(text)]


class SlugTest(unittest.TestCase):
    def test_slug(self):
        self.assertEqual(slug("Poids (kg)"), "poids_kg")
        self.assertEqual(slug("Œdèmes"), "oedemes")
        self.assertEqual(slug("TV : état du col"), "tv_etat_du_col")
        self.assertEqual((slug("Rh+"), slug("Rh-"), slug("T°")), ("rh_plus", "rh_minus", "t_deg"))

    def test_column_ids(self):
        self.assertEqual([abbrev(slug(t)) for t in ("Visite 2", "1er trimestre", "7ème mois", "3ème trimestre")], ["v2", "t1", "m7", "t3"])


class ScannerTest(unittest.TestCase):
    def test_scanner_catches_what_it_should(self):
        for bad in ("XY123456", "06 11 22 33 44", "0611223344", "Nom du Mari", "nom_du_mari", "Adresse :", "Téléphone", "CIN :", "Nom/Prénom de la parturiente"):
            self.assertTrue(scan(bad), bad)
        for good in ("2026-823-001", "10/02/2026", "p02.profession", "Mari/famille", "3587 g", "<staff>", "Patiente fictive n°1/10"):
            self.assertEqual(scan(good), [], good)


class OutputsTest(unittest.TestCase):
    """Runs on the committed outputs; skipped until `make truth` has produced them."""

    def files(self):
        found = [DATA / "ground_truth.json", DATA / "masks.json", *sorted((DATA / "zones").glob("*.json"))]
        if not all(f.exists() for f in found[:2]):
            self.skipTest("run `make truth` first")
        return found

    def test_no_identifier_in_outputs(self):
        for f in self.files():
            self.assertEqual(scan(f.read_text()), [], f.name)

    def test_identifier_slots_and_staff_names_are_absent(self):
        gt = json.loads((DATA / "ground_truth.json").read_text())
        self.files()
        for no, page in gt.items():
            labels = [slug(s["label"]) for s in page["slots"]]
            self.assertFalse(IDENTIFIER_LABELS & set(labels), no)
            if page["page_type"] == 2:
                self.assertEqual(labels.count("profession"), 1, "only the woman's profession is kept")
            for s in page["slots"]:
                if slug(s["label"]) in {"examen_fait_par", "vu_par"}:
                    self.assertIn(s["value"], ("", STAFF), f"page {no} {s['key']}")

    def test_same_layout_same_keys(self):
        gt = json.loads((DATA / "ground_truth.json").read_text())
        self.files()
        by_type = {}
        for no, page in gt.items():
            keys = [s["key"] for s in page["slots"]]
            self.assertEqual(len(keys), len(set(keys)), f"duplicate keys on page {no}")
            by_type.setdefault(page["page_type"], []).append(set(keys))
        for pt, sets in by_type.items():
            self.assertTrue(all(s == sets[0] for s in sets), f"page type {pt}: key sets differ between patients")

    def test_zones_cover_template_cells_without_identifiers(self):
        for f in sorted((DATA / "zones").glob("*.json")):
            z = json.loads(f.read_text())
            keys = [c["key"] for zone in z["zones"] for c in zone["cells"]]
            self.assertEqual(len(keys), len(set(keys)), f.name)
            for zone in z["zones"]:
                self.assertLessEqual(sum(c["kind"] == "text" for c in zone["cells"]), 24, zone["id"])


if __name__ == "__main__":
    unittest.main()
