"""Text normalizer for the eval; tools/eval/normalize.mjs is the same rule in JS.

Comparison rule: two values are equal when their normal forms are equal. The normal
form is case-folded, without accents (so "Néant" = "Neant"), with a decimal comma
turned into a dot, and with ALL whitespace removed: the PDF text layer and the model
both add or drop spaces inside tokens ("6 2. 7", "R AS", "3587 g"). A dropped letter
is not repaired: "N ant" does not equal "Néant" (it equals "Nant").
"""
import re
import unicodedata

_MAP = str.maketrans({"œ": "oe", "æ": "ae", "’": "'", "‘": "'", "–": "-", "—": "-", "−": "-"})


def normalize(value):
    s = unicodedata.normalize("NFD", str(value)).lower().translate(_MAP)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"(\d)\s*,\s*(\d)", r"\1.\2", s)
    return re.sub(r"\s+", "", s)
