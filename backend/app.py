"""
app.py - Flask backend (REST API) for the Huffman text-compression simulator.

Run:   python backend/app.py
Open:  http://127.0.0.1:5000

Endpoints
---------
GET  /api/health         liveness check
GET  /api/samples        sample inputs for the UI
POST /api/compress       JSON {text, repeats} or multipart file -> full analysis
POST /api/decompress     multipart .huff file                   -> restored text
POST /api/benchmark      compare English / source code / random datasets
POST /api/scalability    encode/decode time versus input size
"""

from __future__ import annotations

import base64
import binascii
import os
from pathlib import Path

from flask import Flask, jsonify, request

import benchmark as bm
import huffman as hf

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"

MAX_TEXT_CHARS = 2_000_000       # largest text accepted for compression
MAX_TREE_LEAVES = 128            # draw the tree only up to this many symbols
MAX_TABLE_ROWS = 500
RIBBON_CHARS = 24

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024


# --------------------------------------------------------------------------
# Plumbing: CORS (lets you open index.html directly), errors, small helpers
# --------------------------------------------------------------------------
@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@app.errorhandler(hf.HuffmanError)
def handle_huffman_error(err):
    return jsonify(error=str(err)), 400


@app.errorhandler(413)
def handle_too_large(_err):
    return jsonify(error="The upload is too large (limit 16 MB)."), 413


@app.errorhandler(404)
def handle_not_found(_err):
    if request.path.startswith("/api/"):
        return jsonify(error="Unknown API endpoint."), 404
    return "Not found", 404


def _int(value, default, lo, hi):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _read_text_input():
    """Text comes either from an uploaded file (exact bytes) or from JSON."""
    if "file" in request.files:
        upload = request.files["file"]
        raw = upload.read()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise hf.HuffmanError("The file is not valid UTF-8 text. "
                                  "Upload a plain-text or source-code file.") from exc
        source = upload.filename or "uploaded file"
        repeats = _int(request.form.get("repeats"), 5, 1, 10)
    else:
        payload = request.get_json(silent=True) or {}
        text = payload.get("text", "")
        if not isinstance(text, str):
            raise hf.HuffmanError("'text' must be a string.")
        source = None
        repeats = _int(payload.get("repeats"), 5, 1, 10)
    if not text:
        raise hf.HuffmanError("The input is empty - there is nothing to compress.")
    if len(text) > MAX_TEXT_CHARS:
        raise hf.HuffmanError(f"The input has {len(text):,} characters; "
                              f"the limit is {MAX_TEXT_CHARS:,}.")
    return text, source, repeats


def _tree_to_dict(node, codes):
    if node.is_leaf():
        return {"char": node.char, "freq": node.freq, "code": codes[node.char]}
    d = {"freq": node.freq, "label": node.label}
    if node.left is not None:
        d["left"] = _tree_to_dict(node.left, codes)
    if node.right is not None:
        d["right"] = _tree_to_dict(node.right, codes)
    return d


def _build_compress_payload(text, enc, dec, metrics, source):
    total = enc.char_count
    rows = sorted(enc.freq.items(), key=lambda kv: (-kv[1], kv[0]))
    table = [{
        "char": ch, "freq": f, "prob": f / total, "code": enc.codes[ch],
        "length": len(enc.codes[ch]), "bits_total": f * len(enc.codes[ch]),
    } for ch, f in rows[:MAX_TABLE_ROWS]]

    k = len(enc.freq)
    tree = _tree_to_dict(enc.root, enc.codes) if k <= MAX_TREE_LEAVES else None

    ribbon = [{"char": ch, "code": enc.codes[ch], "fixed_bits": len(ch.encode("utf-8")) * 8}
              for ch in text[:RIBBON_CHARS]]

    return {
        "source": source,
        "metrics": metrics,
        "table": table,
        "table_truncated": k > MAX_TABLE_ROWS,
        "tree": tree,
        "steps": enc.steps,
        "steps_total": max(0, k - 1),
        "ribbon": ribbon,
        "bits_preview": enc.bits[:512],
        "bits_total": len(enc.bits),
        "decoded_preview": dec.text[:3000],
        "decoded_truncated": len(dec.text) > 3000,
        "compressed_base64": base64.b64encode(enc.compressed).decode("ascii"),
    }


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/health")
def health():
    return jsonify(status="ok")


@app.get("/api/samples")
def samples():
    return jsonify(bm.sample_texts())


@app.post("/api/compress")
def api_compress():
    text, source, repeats = _read_text_input()
    repeats = hf.adaptive_repeats(len(text), repeats)
    enc, dec, metrics = hf.measure(text, repeats=repeats, record_steps=True)
    return jsonify(_build_compress_payload(text, enc, dec, metrics, source))


@app.post("/api/decompress")
def api_decompress():
    if "file" in request.files:
        data = request.files["file"].read()
        repeats = _int(request.form.get("repeats"), 3, 1, 10)
    else:
        payload = request.get_json(silent=True) or {}
        try:
            data = base64.b64decode(payload.get("data_base64", ""), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise hf.HuffmanError("The data is not valid base64.") from exc
        repeats = _int(payload.get("repeats"), 3, 1, 10)
    if not data:
        raise hf.HuffmanError("No compressed data was received.")

    first = hf.decompress(data)
    repeats = hf.adaptive_repeats(first.char_count, repeats)
    runs = [first.timings["total"]] + [hf.decompress(data).timings["total"]
                                       for _ in range(repeats - 1)]
    runs.sort()
    median = runs[len(runs) // 2]
    return jsonify({
        "text": first.text,
        "chars": first.char_count,
        "restored_bytes": len(first.text.encode("utf-8")),
        "compressed_bytes": len(data),
        "decode_ms": median * 1000,
        "repeats": repeats,
    })


@app.post("/api/benchmark")
def api_benchmark():
    p = request.get_json(silent=True) or {}
    keys = p.get("datasets") or list(bm.BUILTIN)
    custom = p.get("custom") or []
    if not isinstance(keys, list) or not isinstance(custom, list):
        raise hf.HuffmanError("Invalid request.")
    result = bm.run_benchmark(
        size_kb=_int(p.get("size_kb"), 100, 1, 1024),
        repeats=_int(p.get("repeats"), 3, 1, 10),
        seed=_int(p.get("seed"), 42, 0, 2**31 - 1),
        keys=keys, custom=custom[:8],
    )
    return jsonify(result)


@app.post("/api/scalability")
def api_scalability():
    p = request.get_json(silent=True) or {}
    raw = p.get("sizes_kb") or [10, 50, 100, 250, 500]
    if not isinstance(raw, list):
        raise hf.HuffmanError("Invalid request.")
    sizes = sorted({_int(s, 10, 1, 1024) for s in raw})[:8]
    return jsonify(bm.run_scalability(
        sizes, repeats=_int(p.get("repeats"), 3, 1, 10),
        seed=_int(p.get("seed"), 42, 0, 2**31 - 1)))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"Huffman Lab running on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
