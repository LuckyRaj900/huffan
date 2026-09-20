/* Huffman Lab - frontend logic (plain JavaScript, no dependencies). */
"use strict";

const API_BASE = window.HUFFMAN_API_URL ||
  (location.protocol === "file:" ? "http://127.0.0.1:5000" : "");

/* ====================================================================
   Helpers
   ==================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const fmtFixed = (n, d = 2) =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtBytes = (n) => `${fmtInt(n)} B`;
function fmtBytesHuman(n) {
  if (n >= 1048576) return `${fmtFixed(n / 1048576)} MB`;
  if (n >= 1024) return `${fmtFixed(n / 1024)} KB`;
  return "";
}
function fmtMs(ms) {
  if (ms < 1) return `${fmtFixed(ms, 3)} ms`;
  if (ms < 100) return `${fmtFixed(ms, 2)} ms`;
  return `${fmtFixed(ms, 1)} ms`;
}
function msNum(ms) {
  if (ms < 1) return fmtFixed(ms, 3);
  if (ms < 100) return fmtFixed(ms, 2);
  return fmtFixed(ms, 1);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Printable stand-ins for whitespace and control characters. */
function charLabel(ch) {
  switch (ch) {
    case " ": return "\u2423";
    case "\n": return "\\n";
    case "\t": return "\\t";
    case "\r": return "\\r";
  }
  const cp = ch.codePointAt(0);
  if (cp < 32 || cp === 127) return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
  return ch;
}
function charName(ch) {
  return { " ": "space", "\n": "newline", "\t": "tab", "\r": "carriage return" }[ch] || "";
}

/* A code word with every 0 in cobalt and every 1 in raspberry. */
function codeHtml(code) {
  let out = "";
  for (const b of code) out += `<span class="b${b}">${b}</span>`;
  return out;
}

const utf8 = new TextEncoder();
function fixedBinary(ch) {
  return Array.from(utf8.encode(ch)).map((b) => b.toString(2).padStart(8, "0")).join("");
}

function show(el, on = true) { el.hidden = !on; }
function showError(id, msg) { const el = $(id); el.textContent = msg; show(el, true); el.scrollIntoView({ block: "nearest" }); }
function hideError(id) { show($(id), false); }

function setBusy(btn, on, label) {
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    btn.classList.add("busy");
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
function b64ToBlob(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: "application/octet-stream" });
}

/* ====================================================================
   API
   ==================================================================== */
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, options);
  } catch (e) {
    throw new Error("Cannot reach the backend. Start it with: python backend/app.py");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `The request failed (${res.status}).`);
  return data;
}
const postJSON = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function checkBackend() {
  const el = $("#status");
  try {
    await api("/api/health");
    el.textContent = "Backend connected";
    el.className = "status ok";
  } catch (e) {
    el.textContent = "Backend offline: run python backend/app.py";
    el.className = "status bad";
  }
}

/* ====================================================================
   Tabs (shared by the main tabs and the result sub-tabs)
   ==================================================================== */
function wireTablist(list, buttonSel, onSelect) {
  const buttons = $$(buttonSel, list);
  const select = (btn, focus = false) => {
    buttons.forEach((b) => { b.setAttribute("aria-selected", b === btn ? "true" : "false"); b.tabIndex = b === btn ? 0 : -1; });
    if (focus) btn.focus();
    onSelect(btn);
  };
  buttons.forEach((btn, i) => {
    btn.addEventListener("click", () => select(btn));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); select(buttons[(i + 1) % buttons.length], true); }
      if (e.key === "ArrowLeft") { e.preventDefault(); select(buttons[(i - 1 + buttons.length) % buttons.length], true); }
    });
  });
  return { select: (name) => { const b = buttons.find((x) => (x.dataset.tab || x.dataset.pane) === name); if (b) select(b); } };
}

const mainTabs = wireTablist($(".tabs"), ".tab-btn", (btn) => {
  $$(".tab").forEach((s) => { s.hidden = s.id !== "tab-" + btn.dataset.tab; });
  history.replaceState(null, "", "#" + btn.dataset.tab);
});

/* ====================================================================
   Compress tab
   ==================================================================== */
const state = { file: null, last: null, huff: null, benchFiles: [], bench: null, treeDrawn: false };
const inputEl = $("#input-text");

function updateInputMeta() {
  $("#input-meta").textContent = state.file
    ? `${fmtBytes(state.file.size)} in file (preview shows the first part)`
    : `${fmtInt(inputEl.value.length)} characters`;
}
inputEl.addEventListener("input", updateInputMeta);
inputEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("#btn-compress").click();
});

function clearFile() {
  state.file = null;
  $("#file-input").value = "";
  inputEl.readOnly = false;
  show($("#file-chip"), false);
  updateInputMeta();
}
$("#file-clear").addEventListener("click", () => { clearFile(); inputEl.value = ""; updateInputMeta(); });

$("#file-input").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  state.file = f;
  inputEl.value = await f.slice(0, 20000).text();
  inputEl.readOnly = true;
  $("#file-name").textContent = f.name;
  show($("#file-chip"), true);
  updateInputMeta();
});

$$("[data-sample]").forEach((btn) => btn.addEventListener("click", async () => {
  hideError("#compress-error");
  try {
    const samples = await api("/api/samples");
    clearFile();
    inputEl.value = samples[btn.dataset.sample];
    updateInputMeta();
  } catch (err) { showError("#compress-error", err.message); }
}));

$("#btn-compress").addEventListener("click", async () => {
  const btn = $("#btn-compress");
  hideError("#compress-error");
  const repeats = $("#repeats").value;
  setBusy(btn, true, "Compressing...");
  try {
    let data;
    if (state.file) {
      const fd = new FormData();
      fd.append("file", state.file);
      fd.append("repeats", repeats);
      data = await api("/api/compress", { method: "POST", body: fd });
    } else {
      const text = inputEl.value;
      if (!text) throw new Error("Enter some text, load a sample, or choose a file first.");
      data = await postJSON("/api/compress", { text, repeats: Number(repeats) });
    }
    renderResult(data);
  } catch (err) {
    showError("#compress-error", err.message);
  } finally {
    setBusy(btn, false);
  }
});

/* ---------------------------- result view --------------------------- */
function sizebarHtml(m) {
  const max = Math.max(m.original_bytes, m.compressed_bytes);
  const pct = (n) => ((n / max) * 100).toFixed(3);
  return `
  <div class="sizebar">
    <div class="row"><span>Original</span>
      <div class="track"><div class="seg orig" data-w="${pct(m.original_bytes)}"></div></div>
      <span class="val">${fmtBytes(m.original_bytes)}</span></div>
    <div class="row"><span>Compressed</span>
      <div class="track"><div class="seg header" data-w="${pct(m.header_bytes)}"></div><div class="seg payload" data-w="${pct(m.payload_bytes)}"></div></div>
      <span class="val">${fmtBytes(m.compressed_bytes)}</span></div>
    <div class="sizebar-legend"><span><i class="l-header"></i>Tree header ${fmtBytes(m.header_bytes)}</span><span><i class="l-payload"></i>Encoded data ${fmtBytes(m.payload_bytes)}</span></div>
  </div>`;
}

function readoutHtml(m) {
  const item = (k, v, s = "") =>
    `<div><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
  const orig = [fmtBytesHuman(m.original_bytes), `${fmtInt(m.chars)} characters`].filter(Boolean).join(", ");
  const comp = fmtBytesHuman(m.compressed_bytes);
  return `<div class="readout">
    ${item("Original size", fmtBytes(m.original_bytes), orig)}
    ${item("Compressed size", fmtBytes(m.compressed_bytes), comp)}
    ${item("Compression ratio", `${fmtFixed(m.ratio)}<small> : 1</small>`, `compressed is ${fmtFixed(m.percent_of_original, 1)}% of the original`)}
    ${item("Space saved", `${fmtFixed(m.space_saved_percent, 1)}<small>%</small>`, `${fmtFixed(m.effective_bits_per_char)} bits per character stored`)}
    ${item("Encoding time", `${msNum(m.encode_ms)}<small> ms</small>`, `median of ${m.repeats} run${m.repeats > 1 ? "s" : ""}`)}
    ${item("Decoding time", `${msNum(m.decode_ms)}<small> ms</small>`, `median of ${m.repeats} run${m.repeats > 1 ? "s" : ""}`)}
  </div>`;
}

function renderResult(d) {
  state.last = d;
  state.treeDrawn = false;
  const m = d.metrics;
  const out = $("#result");

  const notice = m.compressed_bytes >= m.original_bytes
    ? `<div class="notice warn">The compressed file is larger than the input. The tree header takes ${fmtBytes(m.header_bytes)}, and this text is too short (or its characters too evenly spread) to earn that back. Try a longer text.</div>`
    : "";
  const badge = m.verified
    ? `<span class="badge ok">Lossless</span><span>The text decoded from the compressed bytes matches the input exactly.</span>`
    : `<span class="badge bad">Mismatch</span><span>The decoded text differs from the input.</span>`;
  const heading = d.source ? esc(d.source) : `${fmtInt(m.chars)} characters, ${fmtInt(m.unique_symbols)} distinct`;

  out.innerHTML = `
  <section class="panel summary">
    <div class="panel-head"><h2>Result</h2><span class="muted">${heading}</span></div>
    ${sizebarHtml(m)}
    ${readoutHtml(m)}
    ${notice}
    <div class="verify-row">${badge}<span class="spacer"></span>
      <button class="btn" id="btn-download" type="button">Download .huff file</button></div>
  </section>

  <div class="subtabs" role="tablist" id="subtabs" aria-label="Result details">
    <button class="subtab" role="tab" data-pane="ribbon" aria-selected="true">Bit savings</button>
    <button class="subtab" role="tab" data-pane="tree" aria-selected="false" tabindex="-1">Huffman tree</button>
    <button class="subtab" role="tab" data-pane="table" aria-selected="false" tabindex="-1">Code table</button>
    <button class="subtab" role="tab" data-pane="steps" aria-selected="false" tabindex="-1">Greedy merges</button>
    <button class="subtab" role="tab" data-pane="analysis" aria-selected="false" tabindex="-1">Analysis</button>
    <button class="subtab" role="tab" data-pane="stream" aria-selected="false" tabindex="-1">Bit stream and decoded text</button>
  </div>
  <section class="panel pane" id="pane-ribbon">${ribbonPane(d)}</section>
  <section class="panel pane" id="pane-tree" hidden>${treePane(d)}</section>
  <section class="panel pane" id="pane-table" hidden>${tablePane(d)}</section>
  <section class="panel pane" id="pane-steps" hidden>${stepsPane(d)}</section>
  <section class="panel pane" id="pane-analysis" hidden>${analysisPane(d)}</section>
  <section class="panel pane" id="pane-stream" hidden>${streamPane(d)}</section>`;
  show(out, true);

  $("#btn-download").addEventListener("click", () => {
    const base = (d.source || "text").replace(/\.[^.]+$/, "") || "text";
    downloadBlob(b64ToBlob(d.compressed_base64), base + ".huff");
  });

  wireTablist($("#subtabs"), ".subtab", (btn) => {
    $$(".pane", out).forEach((p) => { p.hidden = p.id !== "pane-" + btn.dataset.pane; });
    if (btn.dataset.pane === "tree" && !state.treeDrawn) drawTree(d);
  });
  wireTablePane(d);
  wireStepsPane(d);

  /* One reveal: the size bars fill (here) and the Huffman codes shrink out of their 8-bit slots (CSS). */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$(".seg[data-w]", out).forEach((s) => { s.style.width = s.dataset.w + "%"; });
  }));
  out.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---- pane: bit ribbon ---- */
function ribbonPane(d) {
  const r = d.ribbon;
  const fixedTotal = r.reduce((s, x) => s + x.fixed_bits, 0);
  const codeTotal = r.reduce((s, x) => s + x.code.length, 0);
  const saved = fixedTotal - codeTotal;
  const cols = r.map((x) => {
    const fixed = x.fixed_bits, len = x.code.length;
    const w = Math.max(fixed, len);
    return `<div class="rcol" style="--w:${w}" title="${esc(charLabel(x.char))}: ${len} bits instead of ${fixed}">
      <div class="rch">${esc(charLabel(x.char))}</div>
      <div class="rslot"><div class="rcell fixed" style="--n:${fixed}">${fixedBinary(x.char)}</div></div>
      <div class="rslot"><div class="rcell huff ${len > fixed ? "longer" : ""}" style="--n:${len};--w:${w}">${codeHtml(x.code)}</div></div>
    </div>`;
  }).join("");
  return `
    <div><h2>Where the bits are saved</h2>
    <p class="muted">Each column is one character of your text. The top row is how it is normally stored. The bottom row is its Huffman code. Hatched space is saved.</p></div>
    <div class="ribbon-wrap">
      <div class="ribbon-labels"><div>As stored</div><div>Huffman</div></div>
      <div class="ribbon-scroll"><div class="ribbon grow">${cols}</div></div>
    </div>
    <p class="ribbon-note">In these first ${r.length} characters: <strong>${fmtInt(fixedTotal)} bits</strong> stored,
      <strong>${fmtInt(codeTotal)} bits</strong> with Huffman codes
      (${saved >= 0 ? "saves" : "costs"} ${fmtInt(Math.abs(saved))} bits, ${fmtFixed(Math.abs(saved) / fixedTotal * 100, 1)}%).</p>`;
}

/* ---- pane: tree ---- */
function treePane(d) {
  if (!d.tree) {
    return `<h2>Huffman tree</h2><div class="notice info">The tree is not drawn for more than 128 distinct characters (this text has ${fmtInt(d.metrics.unique_symbols)}). The code table lists every code.</div>`;
  }
  return `
    <div><h2>Huffman tree</h2>
    <p class="muted">Leaves hold characters and their counts. Internal nodes hold the sum of their children. A left edge is <span class="b0">0</span>, a right edge is <span class="b1">1</span>. Frequent characters sit near the root.</p></div>
    <div class="tree-tools">
      <button class="btn small" id="tree-out" type="button" aria-label="Zoom out">Zoom out</button>
      <button class="btn small" id="tree-in" type="button" aria-label="Zoom in">Zoom in</button>
      <button class="btn small" id="tree-fit" type="button">Fit to width</button>
      <span class="muted" id="tree-info"></span>
    </div>
    <div class="tree-wrap" id="tree-wrap"></div>`;
}

function drawTree(d) {
  if (!d.tree) return;
  state.treeDrawn = true;
  const DX = 46, DY = 68, PAD = 26, LW = 38, LH = 38, IH = 24;

  let leaves = 0, maxDepth = 0;
  (function layout(n, depth) {
    n._d = depth;
    maxDepth = Math.max(maxDepth, depth);
    if (!n.left && !n.right) { n._x = leaves++ * DX; return; }
    if (n.left) layout(n.left, depth + 1);
    if (n.right) layout(n.right, depth + 1);
    n._x = n.left && n.right ? (n.left._x + n.right._x) / 2 : (n.left || n.right)._x;
  })(d.tree, 0);

  const W = (leaves - 1) * DX + LW + PAD * 2;
  const H = maxDepth * DY + LH + PAD * 2;
  const X = (n) => n._x + PAD + LW / 2;
  const Y = (n) => n._d * DY + PAD + LH / 2;
  const isLeaf = (n) => !n.left && !n.right;

  let edges = "", nodes = "";
  (function walk(n) {
    const px = X(n), py = Y(n);
    const kids = [[n.left, "0"], [n.right, "1"]];
    for (const [c, bit] of kids) {
      if (!c) continue;
      const cx = X(c), cy = Y(c);
      const y1 = py + IH / 2, y2 = cy - (isLeaf(c) ? LH / 2 : IH / 2), mid = (y1 + y2) / 2;
      edges += `<path class="t-edge" d="M${px},${y1} C${px},${mid} ${cx},${mid} ${cx},${y2}"/>`;
      const lx = (px + cx) / 2, ly = y1 + (y2 - y1) * 0.5;
      edges += `<circle class="t-bitbg" cx="${lx}" cy="${ly}" r="7"/><text class="t-bit b${bit}" x="${lx}" y="${ly}">${bit}</text>`;
      walk(c);
    }
    if (isLeaf(n)) {
      nodes += `<g class="t-node t-leaf"><title>${esc(charLabel(n.char))}: count ${n.freq}, code ${n.code}</title>
        <rect x="${px - LW / 2}" y="${py - LH / 2}" width="${LW}" height="${LH}" rx="5"/>
        <text class="t-txt" x="${px}" y="${py - 6}">${esc(charLabel(n.char))}</text>
        <text class="t-sub" x="${px}" y="${py + 10}">${fmtInt(n.freq)}</text></g>`;
    } else {
      const label = fmtInt(n.freq);
      const w = Math.max(30, label.length * 7.4 + 12);
      nodes += `<g class="t-node"><title>${n.label}: total ${n.freq}</title>
        <rect x="${px - w / 2}" y="${py - IH / 2}" width="${w}" height="${IH}" rx="12"/>
        <text class="t-txt" x="${px}" y="${py}">${label}</text></g>`;
    }
  })(d.tree);

  const wrap = $("#tree-wrap");
  wrap.innerHTML = `<svg id="tree-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Huffman tree">${edges}${nodes}</svg>`;
  const svg = $("#tree-svg");
  let zoom = 1;
  const apply = () => {
    svg.style.width = `${Math.round(W * zoom)}px`;
    svg.style.height = `${Math.round(H * zoom)}px`;
    $("#tree-info").textContent = `${fmtInt(leaves)} leaves, depth ${maxDepth}, zoom ${Math.round(zoom * 100)}%`;
  };
  const fit = () => { zoom = Math.min(1.4, Math.max(0.25, (wrap.clientWidth - 4) / W)); apply(); };
  $("#tree-in").addEventListener("click", () => { zoom = Math.min(3, zoom * 1.25); apply(); });
  $("#tree-out").addEventListener("click", () => { zoom = Math.max(0.2, zoom / 1.25); apply(); });
  $("#tree-fit").addEventListener("click", fit);
  if (W > wrap.clientWidth) fit(); else apply();
}

/* ---- pane: code table ---- */
function tablePane(d) {
  return `
    <div><h2>Code table</h2>
    <p class="muted">Sorted by frequency. More frequent characters get shorter codes.</p></div>
    <div class="table-tools">
      <input type="search" id="table-filter" placeholder="Filter by character or code" aria-label="Filter the code table">
      <span class="muted" id="table-count"></span>
    </div>
    <div class="scroll tall"><table class="data" id="code-table"></table></div>
    ${d.table_truncated ? `<p class="muted">Showing the ${d.table.length} most frequent of ${fmtInt(d.metrics.unique_symbols)} distinct characters.</p>` : ""}`;
}
function wireTablePane(d) {
  const table = $("#code-table");
  const draw = () => {
    const q = $("#table-filter").value.toLowerCase();
    const rows = d.table.filter((r) =>
      !q || r.char.toLowerCase().includes(q) || charName(r.char).includes(q) || r.code.startsWith(q));
    table.innerHTML = `<thead><tr><th>Character</th><th>Count</th><th>Share</th><th class="left">Code</th><th>Bits</th><th>Total bits</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><span class="glyph">${esc(charLabel(r.char))}</span> <span class="muted">${charName(r.char)}</span></td>
        <td>${fmtInt(r.freq)}</td><td>${fmtFixed(r.prob * 100, 2)}%</td>
        <td class="left bits">${codeHtml(r.code)}</td><td>${r.length}</td><td>${fmtInt(r.bits_total)}</td></tr>`).join("")}</tbody>`;
    $("#table-count").textContent = `${fmtInt(rows.length)} of ${fmtInt(d.table.length)} shown`;
  };
  $("#table-filter").addEventListener("input", draw);
  draw();
}

/* ---- pane: greedy merges ---- */
function stepsPane(d) {
  if (!d.steps.length) {
    return `<h2>Greedy merges</h2><div class="notice info">The text has a single distinct character, so no merge is needed. It gets the 1-bit code 0.</div>`;
  }
  return `
    <div><h2>Greedy merges</h2>
    <p class="muted">At every step the two nodes with the smallest counts are removed from the heap and merged. Leaves are shown as characters, internal nodes as N1, N2, and so on.</p></div>
    <div class="scroll tall"><table class="data" id="steps-table"></table></div>
    <div id="steps-more"></div>`;
}
function wireStepsPane(d) {
  if (!d.steps.length) return;
  let limit = 60;
  const node = (x) => x.leaf
    ? `<span class="leaf-tag">${esc(charLabel(x.label))}</span> ${fmtInt(x.freq)}`
    : `<span class="node-tag">${esc(x.label)}</span> ${fmtInt(x.freq)}`;
  const draw = () => {
    const rows = d.steps.slice(0, limit);
    $("#steps-table").innerHTML = `<thead><tr><th>Step</th><th class="left">Smallest</th><th class="left">Next smallest</th><th class="left">Merged into</th></tr></thead>
      <tbody>${rows.map((s) => `<tr><td>${s.step}</td><td class="left">${node(s.left)}</td><td class="left">${node(s.right)}</td>
        <td class="left"><span class="node-tag">${esc(s.parent.label)}</span> ${fmtInt(s.parent.freq)}</td></tr>`).join("")}</tbody>`;
    const more = $("#steps-more");
    if (rows.length < d.steps.length) {
      more.innerHTML = `<button class="btn small" id="steps-all" type="button">Show all ${fmtInt(d.steps.length)} steps</button>`;
      $("#steps-all").addEventListener("click", () => { limit = d.steps.length; draw(); });
    } else if (d.steps_total > d.steps.length) {
      more.innerHTML = `<p class="muted">Showing the first ${fmtInt(d.steps.length)} of ${fmtInt(d.steps_total)} merges.</p>`;
    } else {
      more.innerHTML = `<p class="muted">${fmtInt(d.steps_total)} merges in total, one fewer than the number of distinct characters.</p>`;
    }
  };
  draw();
}

/* ---- pane: analysis ---- */
function barRows(items, opts = {}) {
  const max = opts.max || Math.max(...items.map((i) => i.value)) * 1.05;
  const pos = (v) => `${Math.min(100, (v / max) * 100).toFixed(2)}%`;
  return `<div class="bars">${items.map((i) => `
    <div class="brow"><div class="blabel">${i.label}</div>
      <div class="btrack"><div class="bfill ${i.cls || ""}" style="width:${pos(i.value)}"></div>
        ${i.marker != null ? `<div class="bmark" style="left:calc(${pos(i.marker)} - 1px)" title="${i.markerTitle || ""}"></div>` : ""}
        ${opts.ref != null ? `<div class="bref" style="left:${pos(opts.ref)}"></div>` : ""}</div>
      <div class="bval">${i.text}</div></div>`).join("")}</div>`;
}

function analysisPane(d) {
  const m = d.metrics;
  const bits = (v) => `${fmtFixed(v)} bits`;
  const rows = [
    { label: "Stored as UTF-8", value: m.stored_bits_per_char, cls: "muted", text: bits(m.stored_bits_per_char) },
    { label: `Fixed-length code (${m.fixed_bits_per_symbol} bits for ${fmtInt(m.unique_symbols)} symbols)`, value: m.fixed_bits_per_symbol, cls: "muted", text: bits(m.fixed_bits_per_symbol) },
    { label: "Huffman average code length", value: m.avg_code_length, cls: "", text: bits(m.avg_code_length) },
    { label: "Huffman including tree header", value: m.effective_bits_per_char, cls: "accent", text: bits(m.effective_bits_per_char) },
    { label: "Shannon entropy (lower bound)", value: m.entropy, cls: "accent2", text: bits(m.entropy) },
  ];
  const gap = m.avg_code_length - m.entropy;
  const stageNames = {
    frequency: "Count frequencies", tree: "Build tree with min-heap", codes: "Generate codes",
    encode: "Encode and pack bits", serialize: "Write file header",
    parse: "Read header, rebuild tree", decode: "Decode bit stream",
  };
  const stageRows = (obj, cls) => {
    const entries = Object.entries(obj);
    const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
    return barRows(entries.map(([k, v]) => ({
      label: stageNames[k] || k, value: v, cls, text: `${fmtMs(v)}`,
    })), { max: total });
  };
  return `
    <div><h2>Analysis</h2>
    <p class="muted">Bits needed per character, from the plain encoding down to the theoretical limit.</p></div>
    ${barRows(rows)}
    <p>Huffman's average code length is <strong>${fmtFixed(m.avg_code_length, 3)} bits</strong> per character, which is
      <strong>${fmtFixed(gap, 3)} bits</strong> above the entropy limit of ${fmtFixed(m.entropy, 3)} bits, so the code is
      <strong>${fmtFixed(m.efficiency * 100, 1)}%</strong> efficient. Huffman coding guarantees the gap stays below 1 bit.
      The tree header adds ${fmtFixed(m.effective_bits_per_char - m.avg_code_length, 3)} bits per character on this input.</p>
    <div class="two-col">
      <div><h3>Encoding time by stage</h3><p class="muted">Total ${fmtMs(m.encode_ms)}</p>${stageRows(m.encode_stages_ms, "accent")}</div>
      <div><h3>Decoding time by stage</h3><p class="muted">Total ${fmtMs(m.decode_ms)}</p>${stageRows(m.decode_stages_ms, "accent2")}</div>
    </div>`;
}

/* ---- pane: bit stream + decoded text ---- */
function streamPane(d) {
  const bytes = d.bits_preview.match(/.{1,8}/g) || [];
  return `
    <div><h2>Encoded bit stream</h2>
    <p class="muted">The first ${fmtInt(d.bits_preview.length)} of ${fmtInt(d.bits_total)} bits, grouped in bytes. This is the data section of the compressed file.</p></div>
    <div class="bitstream">${bytes.map((b) => `<span class="byte">${codeHtml(b)}</span>`).join("")}</div>
    <div><h2>Decoded text</h2>
    <p class="muted">Produced by decoding the compressed bytes with the tree stored in the file header${d.decoded_truncated ? " (preview of the first 3,000 characters)" : ""}.</p></div>
    <pre class="out">${esc(d.decoded_preview)}</pre>`;
}

/* ====================================================================
   Decompress tab
   ==================================================================== */
$("#huff-input").addEventListener("change", (e) => {
  const f = e.target.files[0];
  state.huff = f || null;
  $("#huff-name").textContent = f ? `${f.name} (${fmtBytes(f.size)})` : "No file chosen";
  $("#btn-decompress").disabled = !f;
});

$("#btn-decompress").addEventListener("click", async () => {
  const btn = $("#btn-decompress");
  hideError("#decompress-error");
  setBusy(btn, true, "Decompressing...");
  try {
    const fd = new FormData();
    fd.append("file", state.huff);
    const d = await api("/api/decompress", { method: "POST", body: fd });
    const out = $("#decompress-result");
    const preview = d.text.length > 5000 ? d.text.slice(0, 5000) : d.text;
    const item = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
    out.innerHTML = `<section class="panel summary">
      <div class="panel-head"><h2>Restored text</h2><span class="badge ok">Decoded</span></div>
      <div class="readout">
        ${item("Compressed size", fmtBytes(d.compressed_bytes))}
        ${item("Restored size", fmtBytes(d.restored_bytes))}
        ${item("Characters", fmtInt(d.chars))}
        ${item("Decoding time", `${msNum(d.decode_ms)}<small> ms</small>`)}
      </div>
      <pre class="out">${esc(preview)}</pre>
      ${d.text.length > 5000 ? `<p class="muted">Preview of the first 5,000 characters.</p>` : ""}
      <div class="verify-row"><span class="spacer"></span><button class="btn" id="btn-save-text" type="button">Download restored text</button></div>
    </section>`;
    show(out, true);
    $("#btn-save-text").addEventListener("click", () => {
      const base = state.huff.name.replace(/\.huff$/i, "") || "restored";
      downloadBlob(new Blob([d.text], { type: "text/plain;charset=utf-8" }), base + ".restored.txt");
    });
  } catch (err) {
    show($("#decompress-result"), false);
    showError("#decompress-error", err.message);
  } finally {
    setBusy(btn, false);
    btn.disabled = !state.huff;
  }
});

/* ====================================================================
   Research tab
   ==================================================================== */
function renderBenchFiles() {
  $("#bench-file-list").innerHTML = state.benchFiles.map((f, i) =>
    `<li><span>${esc(f.name)} <span class="muted">${fmtBytes(f.size)}</span></span><button class="link" data-rm="${i}" type="button">Remove</button></li>`).join("");
  $$("[data-rm]").forEach((b) => b.addEventListener("click", () => {
    state.benchFiles.splice(Number(b.dataset.rm), 1);
    renderBenchFiles();
  }));
}
$("#bench-files").addEventListener("change", async (e) => {
  for (const f of Array.from(e.target.files).slice(0, 8)) {
    if (f.size > 2_000_000) { showError("#bench-error", `${f.name} is larger than 2 MB and was skipped.`); continue; }
    state.benchFiles.push({ name: f.name, size: f.size, text: await f.text() });
  }
  e.target.value = "";
  renderBenchFiles();
});

$("#btn-bench").addEventListener("click", async () => {
  const btn = $("#btn-bench");
  hideError("#bench-error");
  const datasets = $$('input[name="ds"]:checked').map((c) => c.value);
  if (!datasets.length && !state.benchFiles.length) {
    showError("#bench-error", "Select at least one dataset or add a file.");
    return;
  }
  setBusy(btn, true, "Running...");
  try {
    const data = await postJSON("/api/benchmark", {
      datasets,
      size_kb: Number($("#bench-size").value),
      repeats: Number($("#bench-repeats").value),
      seed: Number($("#bench-seed").value) || 0,
      custom: state.benchFiles.map((f) => ({ name: f.name, text: f.text })),
    });
    state.bench = data;
    renderBench(data);
  } catch (err) {
    showError("#bench-error", err.message);
  } finally {
    setBusy(btn, false);
  }
});

function renderBench(data) {
  const rs = data.results;
  const out = $("#bench-out");
  const maxRatio = Math.max(...rs.map((r) => r.ratio)) * 1.12;
  const maxBits = Math.max(8, ...rs.map((r) => r.avg_code_length)) * 1.04;

  const head = ["Dataset", "Symbols", "Original", "Compressed", "Ratio", "Saved", "Entropy H", "Avg code L", "Encode", "Decode", "Lossless"];
  const table = `<div class="scroll"><table class="data">
    <thead><tr>${head.map((h, i) => `<th class="${i === 0 ? "left" : ""}">${h}</th>`).join("")}</tr></thead>
    <tbody>${rs.map((r) => `<tr>
      <td class="left"><strong>${esc(r.name)}</strong> <span class="muted">${esc(r.type)}</span></td>
      <td>${fmtInt(r.unique_symbols)}</td><td>${fmtBytes(r.original_bytes)}</td><td>${fmtBytes(r.compressed_bytes)}</td>
      <td><strong>${fmtFixed(r.ratio)} : 1</strong></td><td>${fmtFixed(r.space_saved_percent, 1)}%</td>
      <td>${fmtFixed(r.entropy, 3)}</td><td>${fmtFixed(r.avg_code_length, 3)}</td>
      <td>${fmtMs(r.encode_ms)}</td><td>${fmtMs(r.decode_ms)}</td>
      <td>${r.verified ? '<span class="badge ok">Yes</span>' : '<span class="badge bad">No</span>'}</td></tr>`).join("")}</tbody></table></div>`;

  const ratioBars = barRows(rs.map((r) => ({
    label: esc(r.name), value: r.ratio, cls: "", text: `${fmtFixed(r.ratio)} : 1`,
  })), { max: maxRatio, ref: 1 });

  const bitBars = barRows(rs.map((r) => ({
    label: esc(r.name), value: r.avg_code_length, cls: "accent", text: `${fmtFixed(r.avg_code_length)} bits`,
    marker: r.entropy, markerTitle: `Entropy ${fmtFixed(r.entropy, 3)} bits`,
  })), { max: maxBits, ref: 8 });

  out.innerHTML = `
  <section class="panel">
    <div class="panel-head"><h2>Results at ${fmtInt(data.size_kb)} KB per built-in dataset</h2>
      <button class="btn small" id="bench-csv" type="button">Export CSV</button></div>
    ${table}
  </section>
  <section class="panel">
    <h2>Compression ratio</h2>
    <p class="muted">Original size divided by compressed size. Higher is better. The dashed line marks 1 : 1, no compression.</p>
    ${ratioBars}
  </section>
  <section class="panel">
    <h2>Bits per character</h2>
    <p class="muted">Bar: Huffman average code length. Pink tick: entropy, the lower bound. Dashed line: 8 bits, plain storage.</p>
    ${bitBars}
  </section>
  <section class="panel">
    <h2>What the numbers show</h2>
    <ul class="findings">${findings(rs).map((f) => `<li>${f}</li>`).join("")}</ul>
  </section>`;
  show(out, true);
  $("#bench-csv").addEventListener("click", () => exportBenchCsv(rs));
  out.scrollIntoView({ behavior: "smooth", block: "start" });
}

function findings(rs) {
  const list = [];
  const sorted = [...rs].sort((a, b) => b.ratio - a.ratio);
  const best = sorted[0], worst = sorted[sorted.length - 1];
  if (rs.length > 1) {
    list.push(`<strong>${esc(best.name)}</strong> compressed best at ${fmtFixed(best.ratio)} : 1 (${fmtFixed(best.space_saved_percent, 1)}% smaller). <strong>${esc(worst.name)}</strong> compressed least at ${fmtFixed(worst.ratio)} : 1 (${fmtFixed(worst.space_saved_percent, 1)}% smaller).`);
  }
  const gaps = rs.map((r) => r.avg_code_length - r.entropy);
  list.push(`Every dataset satisfies H \u2264 L < H + 1. The largest gap between Huffman's average code length and the entropy limit is ${fmtFixed(Math.max(...gaps), 3)} bits.`);
  for (const r of rs.filter((x) => x.type === "Random")) {
    list.push(`<strong>${esc(r.name)}</strong> has ${fmtInt(r.unique_symbols)} almost equally likely symbols, so its entropy (${fmtFixed(r.entropy, 3)} bits) sits next to log\u2082(${fmtInt(r.unique_symbols)}) = ${fmtFixed(Math.log2(r.unique_symbols), 3)} bits. There is no skew to exploit, so the saving comes only from the alphabet being smaller than the 256 values a byte can hold.`);
  }
  const eng = rs.find((r) => r.key === "english"), code = rs.find((r) => r.key === "code");
  if (eng && code) {
    list.push(`English and source code both have skewed character frequencies (entropy ${fmtFixed(eng.entropy, 2)} and ${fmtFixed(code.entropy, 2)} bits), which is why they compress well below plain storage.`);
  }
  list.push("A dataset compresses well when a few characters carry most of the probability. The alphabet size and how evenly characters are used matter more than what the text is about.");
  return list;
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportBenchCsv(rs) {
  const cols = [
    ["dataset", "name"], ["type", "type"], ["distinct_symbols", "unique_symbols"], ["characters", "chars"],
    ["original_bytes", "original_bytes"], ["compressed_bytes", "compressed_bytes"], ["header_bytes", "header_bytes"],
    ["compression_ratio", "ratio"], ["space_saved_percent", "space_saved_percent"], ["entropy_bits", "entropy"],
    ["avg_code_length_bits", "avg_code_length"], ["encode_ms", "encode_ms"], ["decode_ms", "decode_ms"], ["lossless", "verified"],
  ];
  const lines = [cols.map((c) => c[0]).join(",")];
  for (const r of rs) lines.push(cols.map(([, k]) => csvCell(typeof r[k] === "number" && !Number.isInteger(r[k]) ? r[k].toFixed(4) : r[k])).join(","));
  downloadBlob(new Blob([lines.join("\n")], { type: "text/csv" }), "huffman_dataset_comparison.csv");
}

/* ---- scaling test ---- */
$("#btn-scale").addEventListener("click", async () => {
  const btn = $("#btn-scale");
  hideError("#scale-error");
  setBusy(btn, true, "Running...");
  try {
    const data = await postJSON("/api/scalability", {
      sizes_kb: [10, 50, 100, 250, 500], repeats: Number($("#bench-repeats").value),
      seed: Number($("#bench-seed").value) || 0,
    });
    renderScale(data);
  } catch (err) {
    showError("#scale-error", err.message);
  } finally {
    setBusy(btn, false);
  }
});

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function lineChartSvg(points) {
  const W = 680, H = 320, L = 60, R = 18, T = 16, B = 44;
  const xMax = Math.max(...points.map((p) => p.size_kb));
  const yMax = niceMax(Math.max(...points.map((p) => Math.max(p.encode_ms, p.decode_ms))) * 1.05);
  const x = (v) => L + (v / xMax) * (W - L - R);
  const y = (v) => H - B - (v / yMax) * (H - T - B);
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtFixed(v, v < 10 ? 1 : 0)}</text>`;
  }
  points.forEach((p) => {
    g += `<text x="${x(p.size_kb)}" y="${H - B + 18}" text-anchor="middle">${p.size_kb}</text>`;
  });
  const line = (key, cls) => `<polyline class="${cls}" points="${points.map((p) => `${x(p.size_kb)},${y(p[key])}`).join(" ")}"/>` +
    points.map((p) => `<circle class="d-${cls.slice(2)}" cx="${x(p.size_kb)}" cy="${y(p[key])}" r="3.6"><title>${p.size_kb} KB: ${fmtMs(p[key])}</title></circle>`).join("");
  return `<svg class="linechart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Encode and decode time against input size">
    ${g}<line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/><line class="axis" x1="${L}" x2="${L}" y1="${T}" y2="${H - B}"/>
    ${line("decode_ms", "l-dec")}${line("encode_ms", "l-enc")}
    <text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">Input size (KB)</text>
    <text x="14" y="${(T + H - B) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(T + H - B) / 2})">Time (ms)</text></svg>`;
}

function renderScale(data) {
  const pts = data.points;
  const first = pts[0], last = pts[pts.length - 1];
  const per = (p, k) => p[k] / p.size_kb;
  const out = $("#scale-out");
  out.innerHTML = `
  <section class="panel">
    <h2>Time against input size</h2>
    <div class="chart-legend"><span><i style="background:var(--b0)"></i>Encoding</span><span><i style="background:var(--b1)"></i>Decoding</span></div>
    ${lineChartSvg(pts)}
    <div class="scroll"><table class="data"><thead><tr><th>Size</th><th>Characters</th><th>Encode</th><th>Decode</th><th>Encode per KB</th><th>Decode per KB</th><th>Ratio</th></tr></thead>
    <tbody>${pts.map((p) => `<tr><td>${p.size_kb} KB</td><td>${fmtInt(p.chars)}</td><td>${fmtMs(p.encode_ms)}</td><td>${fmtMs(p.decode_ms)}</td>
      <td>${fmtMs(per(p, "encode_ms"))}</td><td>${fmtMs(per(p, "decode_ms"))}</td><td>${fmtFixed(p.ratio)} : 1</td></tr>`).join("")}</tbody></table></div>
    <p>Encoding cost per KB is ${fmtMs(per(first, "encode_ms"))} at ${first.size_kb} KB and ${fmtMs(per(last, "encode_ms"))} at ${last.size_kb} KB.
      Decoding cost per KB is ${fmtMs(per(first, "decode_ms"))} and ${fmtMs(per(last, "decode_ms"))}. A roughly constant cost per KB means time grows in proportion to input size, as the O(n) analysis predicts.
      The ratio stays nearly the same because the tree header is paid once and its share shrinks as the text grows.</p>
  </section>`;
  show(out, true);
  out.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ====================================================================
   Start-up
   ==================================================================== */
updateInputMeta();
checkBackend();
const startTab = location.hash.replace("#", "");
if (["compress", "decompress", "research", "about"].includes(startTab)) mainTabs.select(startTab);
