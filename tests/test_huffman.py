"""Run with:  python -m unittest discover -s tests -v"""

import base64
import math
import os
import random
import string
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import huffman as hf          # noqa: E402
import benchmark as bm        # noqa: E402
from app import app           # noqa: E402


class HuffmanCore(unittest.TestCase):
    def roundtrip(self, text):
        enc = hf.compress(text)
        dec = hf.decompress(enc.compressed)
        self.assertEqual(dec.text, text)
        return enc

    def test_known_example(self):
        # a:3 b:2 c:1  ->  code lengths 1, 2, 2  ->  3*1 + 2*2 + 1*2 = 9 bits
        enc = self.roundtrip("aaabbc")
        self.assertEqual(len(enc.bits), 9)
        self.assertEqual(sorted(len(c) for c in enc.codes.values()), [1, 2, 2])

    def test_roundtrip_variety(self):
        samples = [
            "a", "aaaaaaaaaa", "ab", "hello world", "abracadabra alakazam",
            "line1\nline2\r\nline3\ttabbed", "unicode: caf\u00e9 \u4e2d\u6587 \u2603 \U0001f600",
            string.printable * 20,
        ]
        for s in samples:
            with self.subTest(s=s[:20]):
                self.roundtrip(s)

    def test_roundtrip_random_large(self):
        rng = random.Random(1)
        text = "".join(rng.choices(string.printable, k=50_000))
        self.roundtrip(text)

    def test_skewed_distribution_deep_tree(self):
        # Fibonacci-like frequencies force a very deep (degenerate) tree.
        a, b, text = 1, 1, ""
        for i in range(18):
            text += chr(97 + i) * a
            a, b = b, a + b
        enc = self.roundtrip(text)
        self.assertGreaterEqual(max(len(c) for c in enc.codes.values()), 15)

    def test_prefix_free(self):
        enc = hf.compress("the quick brown fox jumps over the lazy dog " * 5)
        codes = list(enc.codes.values())
        for i, a in enumerate(codes):
            for j, b in enumerate(codes):
                if i != j:
                    self.assertFalse(b.startswith(a), (a, b))

    def test_entropy_bounds(self):
        # H <= average code length < H + 1   (Shannon / Huffman theorem)
        path = os.path.join(os.path.dirname(__file__), "..", "backend", "datasets", "english_sample.txt")
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        enc = hf.compress(text)
        h = hf.shannon_entropy(enc.freq)
        avg = hf.average_code_length(enc.freq, enc.codes)
        self.assertLessEqual(h, avg + 1e-9)
        self.assertLess(avg, h + 1)

    def test_more_frequent_gets_shorter_or_equal_code(self):
        enc = hf.compress("aaaaaaaabbbbccd")
        f, c = enc.freq, enc.codes
        for x in f:
            for y in f:
                if f[x] > f[y]:
                    self.assertLessEqual(len(c[x]), len(c[y]))

    def test_empty_input(self):
        with self.assertRaises(hf.HuffmanError):
            hf.compress("")

    def test_single_symbol_code(self):
        enc = hf.compress("zzzz")
        self.assertEqual(enc.codes, {"z": "0"})

    def test_corrupted_files(self):
        good = hf.compress("hello huffman").compressed
        for bad in [b"", b"nope", b"HUF1", good[:10], good[:-3], b"HUF1" + b"\xff" * 30]:
            with self.subTest(bad=bad[:8]):
                with self.assertRaises(hf.HuffmanError):
                    hf.decompress(bad)

    def test_measure_metrics(self):
        text = "to be or not to be, that is the question " * 200
        _, _, m = hf.measure(text, repeats=2)
        self.assertTrue(m["verified"])
        self.assertGreater(m["ratio"], 1.0)
        self.assertEqual(m["compressed_bytes"], m["header_bytes"] + m["payload_bytes"])
        self.assertAlmostEqual(m["ratio"] * m["percent_of_original"] / 100, 1.0, places=6)
        self.assertGreaterEqual(m["encode_ms"], 0)
        self.assertGreaterEqual(m["decode_ms"], 0)


class Benchmarks(unittest.TestCase):
    def test_all_builtin_datasets_roundtrip(self):
        out = bm.run_benchmark(20, 1, 7, list(bm.BUILTIN), [])
        self.assertEqual(len(out["results"]), 4)
        for r in out["results"]:
            self.assertTrue(r["verified"], r["name"])

    def test_random_lowercase_close_to_entropy(self):
        text = bm.random_text(string.ascii_lowercase, 60_000, 3)
        _, _, m = hf.measure(text)
        self.assertAlmostEqual(m["entropy"], math.log2(26), delta=0.01)
        self.assertLess(m["avg_code_length"], m["entropy"] + 1)

    def test_english_beats_random(self):
        out = bm.run_benchmark(50, 1, 1, ["english", "random_ascii"], [])
        ratios = {r["key"]: r["ratio"] for r in out["results"]}
        self.assertGreater(ratios["english"], ratios["random_ascii"])


class Api(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_health_and_index(self):
        self.assertEqual(self.client.get("/api/health").get_json()["status"], "ok")
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_compress_json_then_decompress(self):
        text = "Huffman coding is a greedy algorithm. " * 40
        r = self.client.post("/api/compress", json={"text": text, "repeats": 2})
        self.assertEqual(r.status_code, 200)
        d = r.get_json()
        self.assertTrue(d["metrics"]["verified"])
        self.assertIsNotNone(d["tree"])
        self.assertEqual(len(d["steps"]), d["steps_total"])
        blob = base64.b64decode(d["compressed_base64"])
        r2 = self.client.post("/api/decompress", json={"data_base64": d["compressed_base64"]})
        self.assertEqual(r2.get_json()["text"], text)
        self.assertEqual(r2.get_json()["compressed_bytes"], len(blob))

    def test_compress_file_upload_and_decompress_upload(self):
        import io
        raw = ("caf\u00e9\r\nline two\r\n" * 50).encode("utf-8")
        r = self.client.post("/api/compress", data={"file": (io.BytesIO(raw), "a.txt")},
                             content_type="multipart/form-data")
        d = r.get_json()
        self.assertEqual(d["metrics"]["original_bytes"], len(raw))     # CRLF preserved
        blob = base64.b64decode(d["compressed_base64"])
        r2 = self.client.post("/api/decompress", data={"file": (io.BytesIO(blob), "a.huff")},
                              content_type="multipart/form-data")
        self.assertEqual(r2.get_json()["text"].encode("utf-8"), raw)

    def test_errors_are_json(self):
        r = self.client.post("/api/compress", json={"text": ""})
        self.assertEqual(r.status_code, 400)
        self.assertIn("error", r.get_json())
        r = self.client.post("/api/decompress", json={"data_base64": base64.b64encode(b"junk").decode()})
        self.assertEqual(r.status_code, 400)
        r = self.client.get("/api/nope")
        self.assertEqual(r.status_code, 404)

    def test_benchmark_and_scalability_endpoints(self):
        r = self.client.post("/api/benchmark", json={"size_kb": 10, "repeats": 1})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.get_json()["results"]), 4)
        r = self.client.post("/api/scalability", json={"sizes_kb": [5, 10], "repeats": 1})
        self.assertEqual(len(r.get_json()["points"]), 2)


if __name__ == "__main__":
    unittest.main()
