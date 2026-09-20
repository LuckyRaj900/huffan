"""
benchmark.py - research component.

Compares Huffman compression on different kinds of text:
  * English text                      (bundled prose, datasets/english_sample.txt)
  * Source code                       (this project's own .py / .js / .css / .html files)
  * Random text, printable ASCII      (95 equally likely symbols)
  * Random text, lowercase letters    (26 equally likely symbols)
  * Any custom files uploaded by the user

Every dataset is stretched (by repetition) or cut to the requested size, so
the datasets can be compared at the same length. Huffman coding here is
order-0 (it only looks at single-character frequencies), so repeating a text
does not change its ratio.
"""

from __future__ import annotations

import random
import string
from pathlib import Path
from typing import Dict, List, Optional

import huffman as hf

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
MAX_DATASET_CHARS = 2_000_000

SOURCE_FILES = [
    "backend/huffman.py",
    "backend/app.py",
    "backend/benchmark.py",
    "frontend/script.js",
    "frontend/style.css",
    "frontend/index.html",
]

_FALLBACK_CODE = (
    "def binary_search(items, target):\n"
    "    lo, hi = 0, len(items) - 1\n"
    "    while lo <= hi:\n"
    "        mid = (lo + hi) // 2\n"
    "        if items[mid] == target:\n"
    "            return mid\n"
    "        if items[mid] < target:\n"
    "            lo = mid + 1\n"
    "        else:\n"
    "            hi = mid - 1\n"
    "    return -1\n\n"
)


def _fit(text: str, n_chars: int) -> str:
    """Repeat or cut `text` to exactly n_chars characters."""
    if not text:
        return ""
    reps = n_chars // len(text) + 1
    return (text * reps)[:n_chars]


def english_text() -> str:
    return (BASE_DIR / "datasets" / "english_sample.txt").read_text(encoding="utf-8")


def source_code_text() -> str:
    parts = []
    for rel in SOURCE_FILES:
        path = PROJECT_ROOT / rel
        if path.exists():
            parts.append(path.read_text(encoding="utf-8", errors="ignore"))
    return "\n".join(parts) if parts else _FALLBACK_CODE


def random_text(alphabet: str, n_chars: int, seed: Optional[int]) -> str:
    rng = random.Random(seed)
    return "".join(rng.choices(alphabet, k=n_chars))


PRINTABLE = string.printable[:95]      # digits, letters, punctuation and space

BUILTIN: Dict[str, dict] = {
    "english": {"name": "English text", "type": "English",
                "build": lambda n, seed: _fit(english_text(), n)},
    "code": {"name": "Source code", "type": "Source code",
             "build": lambda n, seed: _fit(source_code_text(), n)},
    "random_ascii": {"name": "Random (printable ASCII)", "type": "Random",
                     "build": lambda n, seed: random_text(PRINTABLE, n, seed)},
    "random_lower": {"name": "Random (lowercase a-z)", "type": "Random",
                     "build": lambda n, seed: random_text(string.ascii_lowercase, n, seed)},
}


def sample_texts() -> Dict[str, str]:
    """Small ready-made inputs for the 'Load sample' buttons."""
    return {
        "english": english_text(),
        "code": (BASE_DIR / "huffman.py").read_text(encoding="utf-8"),
        "random": random_text(PRINTABLE, 1500, None),
    }


def _row(name: str, kind: str, text: str, repeats: int, key: str) -> dict:
    reps = hf.adaptive_repeats(len(text), repeats)
    _, _, m = hf.measure(text, repeats=reps)
    m.update({"key": key, "name": name, "type": kind})
    return m


def run_benchmark(size_kb: int, repeats: int, seed: int,
                  keys: List[str], custom: List[dict]) -> dict:
    n_chars = size_kb * 1024
    results = []
    for key in keys:
        if key not in BUILTIN:
            raise hf.HuffmanError(f"Unknown dataset '{key}'.")
        spec = BUILTIN[key]
        results.append(_row(spec["name"], spec["type"], spec["build"](n_chars, seed), repeats, key))

    for i, item in enumerate(custom):
        text = str(item.get("text", ""))
        if not text:
            continue
        if len(text) > MAX_DATASET_CHARS:
            raise hf.HuffmanError(f"'{item.get('name', 'custom')}' is larger than "
                                  f"{MAX_DATASET_CHARS:,} characters.")
        results.append(_row(str(item.get("name") or f"Custom {i + 1}"), "Custom", text,
                            repeats, f"custom_{i}"))
    if not results:
        raise hf.HuffmanError("Select at least one dataset.")
    return {"size_kb": size_kb, "repeats": repeats, "seed": seed, "results": results}


def run_scalability(sizes_kb: List[int], repeats: int, seed: int) -> dict:
    """Encode/decode time versus input size (English text)."""
    points = []
    for size in sizes_kb:
        text = BUILTIN["english"]["build"](size * 1024, seed)
        reps = hf.adaptive_repeats(len(text), repeats)
        _, _, m = hf.measure(text, repeats=reps)
        points.append({
            "size_kb": size, "chars": m["chars"],
            "encode_ms": m["encode_ms"], "decode_ms": m["decode_ms"],
            "ratio": m["ratio"], "verified": m["verified"],
        })
    return {"dataset": "English text", "points": points}
