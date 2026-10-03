import json
import unittest
from pathlib import Path

from normalize import normalize

CASES = json.loads((Path(__file__).parent / "data" / "normalize_cases.json").read_text())


class NormalizeTest(unittest.TestCase):
    def test_shared_cases(self):
        for raw, expected in CASES:
            self.assertEqual(normalize(raw), expected, raw)

    def test_noisy_spellings_compare_equal(self):
        self.assertEqual(normalize("Néant"), normalize("N éant"))
        self.assertEqual(normalize("3587 g"), normalize("3587g"))
        self.assertNotEqual(normalize("N ant"), normalize("Néant"))  # a dropped letter is not repaired


if __name__ == "__main__":
    unittest.main()
