"""
huffman.py - core of the Huffman Coding text-compression simulator.

DAA concepts used
-----------------
* Greedy algorithm : repeatedly merge the two least-frequent nodes (min-heap).
* Binary trees     : the Huffman tree; a code is the root-to-leaf path
                     (left edge = 0, right edge = 1).
* Huffman coding   : an optimal prefix-free, variable-length code.

Compressed container format (".huff")
-------------------------------------
    offset  size              field
    0       4                 magic  b"HUF1"
    4       4                 number of characters in the original text (uint32, big-endian)
    8       4                 k = number of distinct characters          (uint32, big-endian)
    12      ceil((2k-1)/8)    tree shape, pre-order, bit-packed (1 = leaf, 0 = internal node)
    ...     variable          the k leaf characters, UTF-8 encoded, in pre-order
    ...     1                 number of padding bits in the last payload byte (0-7)
    ...     rest              payload: the Huffman-encoded bit stream

Compressed size reported by the simulator = header + payload, i.e. the real
size of the file, so the cost of storing the tree is not hidden.
"""

from __future__ import annotations

import heapq
import math
import statistics
import struct
from collections import Counter
from dataclasses import dataclass
from time import perf_counter
from typing import Dict, List, Optional, Tuple

MAGIC = b"HUF1"
MAX_CHARS = 5_000_000          # safety limit when decoding untrusted files


class HuffmanError(ValueError):
    """Raised for invalid input or a corrupted compressed file."""


# --------------------------------------------------------------------------
# Binary tree node
# --------------------------------------------------------------------------
class Node:
    """A node of the Huffman tree (a full binary tree: 0 or 2 children)."""

    __slots__ = ("freq", "char", "left", "right", "order", "label")

    def __init__(self, freq, char=None, left=None, right=None, order=0, label=None):
        self.freq = freq
        self.char = char
        self.left = left
        self.right = right
        self.order = order      # insertion order, used only to break ties
        self.label = label      # "N1", "N2", ... for internal nodes (for the UI)

    def is_leaf(self) -> bool:
        return self.left is None and self.right is None

    def __lt__(self, other: "Node") -> bool:
        # Heap ordering: smaller frequency first; older node first on ties,
        # so the resulting tree is deterministic and has low code-length variance.
        return (self.freq, self.order) < (other.freq, other.order)


# --------------------------------------------------------------------------
# Step 1 - frequency analysis
# --------------------------------------------------------------------------
def build_frequency_table(text: str) -> Counter:
    """Count how often each character occurs. O(n)."""
    return Counter(text)


# --------------------------------------------------------------------------
# Step 2 - build the Huffman tree (greedy)
# --------------------------------------------------------------------------
def build_huffman_tree(freq: Dict[str, int], record_steps: bool = False,
                       max_steps: int = 400) -> Tuple[Node, List[dict]]:
    """
    Build the Huffman tree with a min-heap. O(k log k) for k distinct symbols.

    Greedy choice: at every step remove the two nodes with the smallest
    frequencies and merge them under a new parent whose frequency is their sum.
    Returns (root, steps). `steps` describes the merges (for visualisation).
    """
    if not freq:
        raise HuffmanError("Cannot build a Huffman tree for empty input.")

    ordered = sorted(freq.items(), key=lambda kv: (kv[1], kv[0]))
    heap = [Node(f, char=ch, order=i, label=ch) for i, (ch, f) in enumerate(ordered)]
    heapq.heapify(heap)
    next_order = len(heap)
    steps: List[dict] = []

    if len(heap) == 1:
        # Only one distinct character: give it a 1-bit code by adding a dummy root.
        leaf = heap[0]
        return Node(leaf.freq, left=leaf, order=next_order, label="N1"), steps

    merges = 0
    while len(heap) > 1:
        a = heapq.heappop(heap)          # smallest
        b = heapq.heappop(heap)          # second smallest
        merges += 1
        parent = Node(a.freq + b.freq, left=a, right=b, order=next_order,
                      label=f"N{merges}")
        next_order += 1
        heapq.heappush(heap, parent)
        if record_steps and merges <= max_steps:
            steps.append({
                "step": merges,
                "left": {"label": a.label, "leaf": a.is_leaf(), "freq": a.freq},
                "right": {"label": b.label, "leaf": b.is_leaf(), "freq": b.freq},
                "parent": {"label": parent.label, "freq": parent.freq},
            })
    return heap[0], steps


# --------------------------------------------------------------------------
# Step 3 - generate the prefix codes
# --------------------------------------------------------------------------
def generate_codes(root: Optional[Node]) -> Dict[str, str]:
    """Walk the tree (iteratively): left edge = '0', right edge = '1'. O(k)."""
    codes: Dict[str, str] = {}
    if root is None:
        return codes
    stack = [(root, "")]
    while stack:
        node, prefix = stack.pop()
        if node.is_leaf():
            codes[node.char] = prefix or "0"
            continue
        if node.right is not None:
            stack.append((node.right, prefix + "1"))
        if node.left is not None:
            stack.append((node.left, prefix + "0"))
    return codes


# --------------------------------------------------------------------------
# Bit helpers
# --------------------------------------------------------------------------
def pack_bits(bits: str) -> Tuple[bytes, int]:
    """Pack a string of '0'/'1' into bytes. Returns (data, padding_bits)."""
    if not bits:
        return b"", 0
    pad = (-len(bits)) % 8
    padded = bits + "0" * pad
    return int(padded, 2).to_bytes(len(padded) // 8, "big"), pad


def unpack_bits(data: bytes, pad: int) -> str:
    """Inverse of pack_bits."""
    if not data:
        return ""
    n = len(data) * 8
    s = format(int.from_bytes(data, "big"), f"0{n}b")
    return s[: n - pad] if pad else s


# --------------------------------------------------------------------------
# Step 4 / 5 - encode and decode
# --------------------------------------------------------------------------
def encode_text(text: str, codes: Dict[str, str]) -> str:
    """Replace every character with its code word. O(n)."""
    return "".join(map(codes.__getitem__, text))


def decode_bits(bits: str, root: Node, char_count: int) -> str:
    """
    Decode by walking the tree: start at the root, follow one edge per bit,
    and every time a leaf is reached output its character and restart.
    """
    if root.right is None:                      # single-symbol tree
        return root.left.char * char_count
    out: List[str] = []
    append = out.append
    node = root
    for b in bits:
        node = node.right if b == "1" else node.left
        if node.left is None:                   # leaf
            append(node.char)
            node = root
            if len(out) == char_count:
                break
    return "".join(out)


# --------------------------------------------------------------------------
# Container (de)serialisation
# --------------------------------------------------------------------------
def _flatten_tree(root: Node) -> Tuple[str, List[str]]:
    """Pre-order traversal -> (shape bits, leaf characters)."""
    shape: List[str] = []
    symbols: List[str] = []
    stack = [root]
    while stack:
        n = stack.pop()
        if n.is_leaf():
            shape.append("1")
            symbols.append(n.char)
        else:
            shape.append("0")
            stack.append(n.right)
            stack.append(n.left)
    return "".join(shape), symbols


def _build_tree_from_shape(shape: str, symbols: List[str]) -> Node:
    """Rebuild the tree from its pre-order description (iteratively)."""
    if not shape or shape.count("1") != len(symbols):
        raise HuffmanError("Corrupted tree description.")
    sym_iter = iter(symbols)

    def make(bit: str) -> Node:
        return Node(0, char=next(sym_iter)) if bit == "1" else Node(0)

    root = make(shape[0])
    stack = [] if shape[0] == "1" else [root]
    pos = 1
    while stack:
        if pos >= len(shape):
            raise HuffmanError("Corrupted tree description.")
        bit = shape[pos]
        pos += 1
        node = make(bit)
        parent = stack[-1]
        if parent.left is None:
            parent.left = node
        else:
            parent.right = node
            stack.pop()
        if bit == "0":
            stack.append(node)
    if pos != len(shape):
        raise HuffmanError("Corrupted tree description.")
    return root


def _read_utf8_symbols(data: bytes, pos: int, k: int) -> Tuple[List[str], int]:
    symbols: List[str] = []
    i = pos
    for _ in range(k):
        lead = data[i]
        if lead < 0x80:
            n = 1
        elif lead >> 5 == 0b110:
            n = 2
        elif lead >> 4 == 0b1110:
            n = 3
        elif lead >> 3 == 0b11110:
            n = 4
        else:
            raise HuffmanError("Corrupted symbol table.")
        symbols.append(data[i:i + n].decode("utf-8"))
        i += n
    return symbols, i - pos


def _serialize(root: Node, k: int, char_count: int, payload: bytes, pad: int) -> Tuple[bytes, int]:
    tree_root = root.left if k == 1 else root
    shape_bits, symbols = _flatten_tree(tree_root)
    shape_bytes, _ = pack_bits(shape_bits)
    header = (MAGIC + struct.pack(">II", char_count, k) + shape_bytes
              + "".join(symbols).encode("utf-8") + bytes([pad]))
    return header + payload, len(header)


def _parse_container(data: bytes):
    if len(data) < 14 or data[:4] != MAGIC:
        raise HuffmanError("This is not a Huffman Lab file (bad header).")
    char_count, k = struct.unpack(">II", data[4:12])
    if not (1 <= char_count <= MAX_CHARS) or not (1 <= k <= min(char_count, 1_114_112)):
        raise HuffmanError("The file header is corrupted.")
    pos = 12
    shape_len = 2 * k - 1
    shape_nbytes = (shape_len + 7) // 8
    shape_raw = data[pos:pos + shape_nbytes]
    if len(shape_raw) != shape_nbytes:
        raise HuffmanError("The file is truncated.")
    shape = format(int.from_bytes(shape_raw, "big"), f"0{shape_nbytes * 8}b")[:shape_len]
    pos += shape_nbytes
    symbols, used = _read_utf8_symbols(data, pos, k)
    pos += used
    pad = data[pos]
    pos += 1
    if pad > 7:
        raise HuffmanError("The file header is corrupted.")
    root = _build_tree_from_shape(shape, symbols)
    if k == 1:
        root = Node(0, left=root)               # same dummy-root shape as the encoder
    return root, char_count, data[pos:], pad


# --------------------------------------------------------------------------
# Public API: compress / decompress
# --------------------------------------------------------------------------
@dataclass
class CompressResult:
    compressed: bytes
    freq: Counter
    root: Node
    codes: Dict[str, str]
    bits: str
    steps: List[dict]
    header_bytes: int
    payload_bytes: int
    char_count: int
    timings: Dict[str, float]          # seconds


@dataclass
class DecompressResult:
    text: str
    char_count: int
    timings: Dict[str, float]          # seconds


def compress(text: str, record_steps: bool = False) -> CompressResult:
    """Full pipeline: frequencies -> tree -> codes -> bit stream -> file bytes."""
    if not text:
        raise HuffmanError("The input is empty - there is nothing to compress.")
    try:
        text.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise HuffmanError("The text contains characters that cannot be encoded as UTF-8.") from exc

    t0 = perf_counter()
    freq = build_frequency_table(text)
    t1 = perf_counter()
    root, steps = build_huffman_tree(freq, record_steps)
    t2 = perf_counter()
    codes = generate_codes(root)
    t3 = perf_counter()
    bits = encode_text(text, codes)
    payload, pad = pack_bits(bits)
    t4 = perf_counter()
    blob, header_len = _serialize(root, len(freq), len(text), payload, pad)
    t5 = perf_counter()

    return CompressResult(
        compressed=blob, freq=freq, root=root, codes=codes, bits=bits, steps=steps,
        header_bytes=header_len, payload_bytes=len(payload), char_count=len(text),
        timings={"frequency": t1 - t0, "tree": t2 - t1, "codes": t3 - t2,
                 "encode": t4 - t3, "serialize": t5 - t4, "total": t5 - t0},
    )


def decompress(data: bytes) -> DecompressResult:
    """Rebuild the tree from the file header, then decode the payload."""
    t0 = perf_counter()
    try:
        root, char_count, payload, pad = _parse_container(data)
        t1 = perf_counter()
        bits = unpack_bits(payload, pad)
        if len(bits) < char_count:
            raise HuffmanError("The file is truncated (not enough data).")
        text = decode_bits(bits, root, char_count)
    except HuffmanError:
        raise
    except (IndexError, ValueError, StopIteration, struct.error) as exc:
        raise HuffmanError("The file is corrupted or truncated.") from exc
    if len(text) != char_count:
        raise HuffmanError("The file is corrupted (decoded length mismatch).")
    t2 = perf_counter()
    return DecompressResult(text=text, char_count=char_count,
                            timings={"parse": t1 - t0, "decode": t2 - t1, "total": t2 - t0})


# --------------------------------------------------------------------------
# Evaluation parameters
# --------------------------------------------------------------------------
def shannon_entropy(freq: Dict[str, int]) -> float:
    """Entropy in bits/symbol: the lower bound for any symbol-by-symbol code."""
    total = sum(freq.values())
    h = 0.0
    for f in freq.values():
        p = f / total
        h -= p * math.log2(p)
    return h + 0.0


def average_code_length(freq: Dict[str, int], codes: Dict[str, str]) -> float:
    total = sum(freq.values())
    return sum(f * len(codes[c]) for c, f in freq.items()) / total


def adaptive_repeats(n_chars: int, requested: int) -> int:
    """Fewer timing repeats for big inputs so requests stay fast."""
    requested = max(1, int(requested))
    if n_chars > 500_000:
        return 1
    if n_chars > 100_000:
        return min(requested, 3)
    return requested


def _median_by_key(runs: List[Dict[str, float]]) -> Dict[str, float]:
    return {k: statistics.median(r[k] for r in runs) for k in runs[0]}


def measure(text: str, repeats: int = 1, record_steps: bool = False):
    """
    Compress, decompress and verify `text`.
    Returns (CompressResult, DecompressResult, metrics_dict). Timings are the
    median of `repeats` runs, in milliseconds.
    """
    repeats = max(1, int(repeats))
    enc = compress(text, record_steps=record_steps)
    enc_runs = [enc.timings] + [compress(text).timings for _ in range(repeats - 1)]

    dec = decompress(enc.compressed)
    dec_runs = [dec.timings] + [decompress(enc.compressed).timings for _ in range(repeats - 1)]

    enc_t = _median_by_key(enc_runs)
    dec_t = _median_by_key(dec_runs)

    chars = enc.char_count
    original = len(text.encode("utf-8"))
    compressed = len(enc.compressed)
    k = len(enc.freq)
    encoded_bits = sum(f * len(enc.codes[c]) for c, f in enc.freq.items())
    entropy = shannon_entropy(enc.freq)
    avg_len = encoded_bits / chars

    metrics = {
        "chars": chars,
        "unique_symbols": k,
        "original_bytes": original,
        "compressed_bytes": compressed,
        "header_bytes": enc.header_bytes,
        "payload_bytes": enc.payload_bytes,
        "encoded_bits": encoded_bits,
        "ratio": original / compressed,
        "percent_of_original": 100.0 * compressed / original,
        "space_saved_percent": 100.0 * (1 - compressed / original),
        "avg_code_length": avg_len,
        "effective_bits_per_char": compressed * 8 / chars,
        "stored_bits_per_char": original * 8 / chars,
        "fixed_bits_per_symbol": max(1, math.ceil(math.log2(k))) if k > 1 else 1,
        "entropy": entropy,
        "efficiency": (entropy / avg_len) if avg_len else 1.0,
        "encode_ms": enc_t["total"] * 1000,
        "decode_ms": dec_t["total"] * 1000,
        "encode_stages_ms": {k_: v * 1000 for k_, v in enc_t.items() if k_ != "total"},
        "decode_stages_ms": {k_: v * 1000 for k_, v in dec_t.items() if k_ != "total"},
        "repeats": repeats,
        "verified": dec.text == text,
    }
    return enc, dec, metrics


if __name__ == "__main__":
    # Tiny console demo:  python huffman.py
    sample = "abracadabra alakazam"
    result, decoded, m = measure(sample)
    print("text        :", sample)
    print("frequencies :", dict(result.freq))
    for ch, code in sorted(result.codes.items(), key=lambda kv: (len(kv[1]), kv[0])):
        print(f"  {ch!r:5} -> {code}")
    print("encoded bits:", result.bits)
    print("decoded     :", decoded.text, "| lossless:", m["verified"])
    print(f"original {m['original_bytes']} B, compressed {m['compressed_bytes']} B "
          f"(header {m['header_bytes']} B), ratio {m['ratio']:.2f}")
