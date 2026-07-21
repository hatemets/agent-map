/* Agent Map client — vanilla JS + SVG, no build step.
   Every view is a pure function of the RunGraph the server pushes over SSE. */

const NS = "http://www.w3.org/2000/svg";

const state = {
  graph: null,
  view: "tree",
  sessionId: null,
  selectedId: null,
  source: null,
  transform: { x: 0, y: 0, k: 1 },
  fitPending: false,
};

// ── formatting ────────────────────────────────────────────────────────────

const fmtTokens = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n | 0}`;

const fmtUsd = (n) =>
  n == null ? "—" : n >= 10 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function fmtAgo(iso) {
  const d = Date.now() - Date.parse(iso);
  if (!Number.isFinite(d)) return "";
  if (d < 60e3) return "just now";
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m ago`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h ago`;
  return `${Math.floor(d / 86400e3)}d ago`;
}

const clip = (s, n) => (!s ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s);

const CSSVAR = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function modelColor(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) return CSSVAR("--m-opus");
  if (m.includes("sonnet")) return CSSVAR("--m-sonnet");
  if (m.includes("haiku")) return CSSVAR("--m-haiku");
  if (m.includes("fable") || m.includes("mythos")) return CSSVAR("--m-fable");
  return CSSVAR("--m-other");
}

function modelShort(model) {
  const m = (model || "").toLowerCase();
  for (const k of ["opus", "sonnet", "haiku", "fable", "mythos"]) {
    if (m.includes(k)) {
      const v = /(\d[\d.-]*)/.exec(m.split(k)[1] || "");
      return v ? `${k} ${v[1].replace(/-/g, ".")}` : k;
    }
  }
  return model || "unknown";
}

function statusColor(status) {
  if (status === "running") return CSSVAR("--run");
  if (status === "stalled") return CSSVAR("--stall");
  if (status === "failed") return CSSVAR("--fail");
  return CSSVAR("--ink-faint");
}

// ── tiny SVG builder ──────────────────────────────────────────────────────

function el(name, attrs = {}, ...kids) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    n.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return n;
}

// ── tree ordering, shared by every view ───────────────────────────────────

/** Depth-first order with children sorted by start time — the visual spine. */
function orderedAgents(graph) {
  const byId = new Map(graph.agents.map((a) => [a.id, a]));
  const kids = new Map();
  for (const a of graph.agents) {
    if (!a.parentId) continue;
    if (!kids.has(a.parentId)) kids.set(a.parentId, []);
    kids.get(a.parentId).push(a);
  }
  for (const list of kids.values()) {
    list.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  }
  const out = [];
  const walk = (node) => {
    out.push(node);
    for (const c of kids.get(node.id) || []) walk(c);
  };
  const root = graph.agents.find((a) => !a.parentId) || graph.agents[0];
  if (root) walk(root);
  // Safety net: never silently omit an agent the walk didn't reach.
  for (const a of graph.agents) if (!out.includes(a)) out.push(a);
  return { order: out, kids, byId };
}

function timeExtent(graph, order) {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const a of order) {
    const s = Date.parse(a.startedAt);
    if (Number.isFinite(s)) t0 = Math.min(t0, s);
    const e = a.endedAt ? Date.parse(a.endedAt) : Date.now();
    if (Number.isFinite(e)) t1 = Math.max(t1, e);
  }
  if (!Number.isFinite(t0)) t0 = Date.now();
  if (!Number.isFinite(t1) || t1 <= t0) t1 = t0 + 1000;
  return [t0, t1];
}

// ── view: tree ────────────────────────────────────────────────────────────

const NODE_W = 252;
const NODE_H = 56;
const COL = 300;
const ROW = 70;

function renderTree(graph, root) {
  const { order, kids } = orderedAgents(graph);
  const pos = new Map();
  let cursor = 0;

  const layout = (node) => {
    const children = kids.get(node.id) || [];
    if (!children.length) {
      pos.set(node.id, { x: node.depth * COL, y: cursor++ * ROW });
      return;
    }
    children.forEach(layout);
    const first = pos.get(children[0].id).y;
    const last = pos.get(children[children.length - 1].id).y;
    pos.set(node.id, { x: node.depth * COL, y: (first + last) / 2 });
  };
  if (order.length) layout(order[0]);
  // Any agent the walk missed still needs a slot.
  for (const a of order) if (!pos.has(a.id)) pos.set(a.id, { x: a.depth * COL, y: cursor++ * ROW });

  const links = el("g");
  for (const a of order) {
    if (!a.parentId || !pos.has(a.parentId)) continue;
    const p = pos.get(a.parentId);
    const c = pos.get(a.id);
    const x1 = p.x + NODE_W;
    const y1 = p.y + NODE_H / 2;
    const x2 = c.x;
    const y2 = c.y + NODE_H / 2;
    const mid = x1 + (x2 - x1) / 2;
    links.appendChild(
      el("path", {
        class: `link${a.inferred ? " inferred" : ""}`,
        d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
      }),
    );
  }
  root.appendChild(links);

  for (const a of order) {
    const { x, y } = pos.get(a.id);
    const g = el("g", {
      class: `node${a.id === state.selectedId ? " sel" : ""}`,
      transform: `translate(${x},${y})`,
    });
    g.appendChild(el("rect", { class: "node-card", width: NODE_W, height: NODE_H }));
    // Model identity as a coloured spine on the left edge of the card.
    g.appendChild(
      el("rect", { x: 0, y: 0, width: 3, height: NODE_H, fill: modelColor(a.model), rx: 1.5 }),
    );
    g.appendChild(
      el("circle", {
        cx: 15,
        cy: 15,
        r: 3.5,
        fill: statusColor(a.status),
        class: a.status === "running" ? "bar running" : null,
      }),
    );
    g.appendChild(el("text", { class: "node-name", x: 26, y: 19 }, clip(a.name, 27)));
    g.appendChild(el("text", { class: "node-activity", x: 12, y: 35 }, clip(a.activity, 36)));
    g.appendChild(
      el(
        "text",
        { class: "node-meta", x: 12, y: 49 },
        `${modelShort(a.model)} · ${fmtTokens(a.tokens.total)} · ${fmtUsd(a.unpricedModel ? null : a.costUsd)}`,
      ),
    );
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      select(a.id);
    });
    root.appendChild(g);
  }
}

// ── view: timeline ────────────────────────────────────────────────────────

const LANE_LABEL_W = 190;
const LANE_H = 26;

function renderTimeline(graph, root) {
  const { order } = orderedAgents(graph);
  const [t0, t1] = timeExtent(graph, order);
  // Size the time axis to the viewport so the default zoom lands near 1:1 and
  // the labels stay legible, rather than fitting a fixed-width drawing.
  const TL_W = Math.max(600, canvas.getBoundingClientRect().width - LANE_LABEL_W - 180);
  const scale = (t) => LANE_LABEL_W + ((t - t0) / (t1 - t0)) * TL_W;
  const height = order.length * LANE_H;

  // Time axis.
  const axis = el("g");
  const TICKS = 8;
  for (let i = 0; i <= TICKS; i++) {
    const t = t0 + ((t1 - t0) * i) / TICKS;
    const x = scale(t);
    axis.appendChild(el("line", { class: "axis-line", x1: x, y1: 0, x2: x, y2: height + 8 }));
    axis.appendChild(
      el("text", { class: "axis-text", x: x + 4, y: -8 }, fmtDur(t - t0)),
    );
  }
  root.appendChild(axis);

  order.forEach((a, i) => {
    const y = i * LANE_H;
    const s = Date.parse(a.startedAt);
    const e = a.endedAt ? Date.parse(a.endedAt) : Date.now();
    const x = scale(Number.isFinite(s) ? s : t0);
    const w = Math.max(2, scale(Number.isFinite(e) ? e : t1) - x);

    const g = el("g", {
      class: `node${a.id === state.selectedId ? " sel" : ""}`,
      transform: `translate(0,${y})`,
    });
    g.appendChild(
      el(
        "text",
        { class: "lane-label", x: LANE_LABEL_W - 10, y: 17, "text-anchor": "end" },
        clip("  ".repeat(Math.min(a.depth, 4)) + a.name, 30),
      ),
    );
    g.appendChild(
      el("rect", {
        class: `bar${a.status === "running" ? " running" : ""}`,
        x,
        y: 6,
        width: w,
        height: 13,
        fill: modelColor(a.model),
        opacity: a.status === "done" ? 0.75 : 1,
        stroke: a.status === "failed" ? CSSVAR("--fail") : null,
        "stroke-width": a.status === "failed" ? 1.2 : null,
      }),
    );
    g.appendChild(
      el(
        "text",
        { class: "node-meta", x: x + w + 8, y: 17 },
        `${fmtTokens(a.tokens.total)} · ${fmtDur(a.activeMs)}`,
      ),
    );
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      select(a.id);
    });
    root.appendChild(g);
  });
}

// ── view: sequence ────────────────────────────────────────────────────────

const SEQ_LANE = 132;
const SEQ_TOP = 70;

function renderSequence(graph, root) {
  const { order } = orderedAgents(graph);
  const [t0, t1] = timeExtent(graph, order);
  // Match the lifeline height to the viewport for the same reason as the
  // timeline — a fixed 1100px drawing gets scaled into illegibility.
  const SEQ_H = Math.max(560, canvas.getBoundingClientRect().height - SEQ_TOP - 90);
  const colOf = new Map(order.map((a, i) => [a.id, 40 + i * SEQ_LANE]));
  const y = (t) => SEQ_TOP + ((t - t0) / (t1 - t0)) * SEQ_H;

  // Lifelines + headers.
  order.forEach((a) => {
    const x = colOf.get(a.id);
    root.appendChild(
      el("line", { class: "lifeline", x1: x, y1: SEQ_TOP, x2: x, y2: SEQ_TOP + SEQ_H }),
    );
    const g = el("g", { class: "node", transform: `translate(${x - 59},0)` });
    g.appendChild(el("rect", { class: "node-card", width: 118, height: 44 }));
    g.appendChild(
      el("rect", { x: 0, y: 0, width: 3, height: 44, fill: modelColor(a.model), rx: 1.5 }),
    );
    g.appendChild(el("text", { class: "node-name", x: 10, y: 19 }, clip(a.name, 13)));
    g.appendChild(el("text", { class: "node-meta", x: 10, y: 34 }, modelShort(a.model)));
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      select(a.id);
    });
    root.appendChild(g);
  });

  // Messages: prompts down the tree, results back up.
  for (const m of graph.messages) {
    const x1 = colOf.get(m.from);
    const x2 = colOf.get(m.to);
    if (x1 === undefined || x2 === undefined) continue;
    const at = Date.parse(m.at);
    if (!Number.isFinite(at)) continue;
    const yy = y(at);
    const color =
      m.kind === "error"
        ? CSSVAR("--fail")
        : m.kind === "result"
          ? CSSVAR("--ink-faint")
          : CSSVAR("--m-opus");
    const dir = x2 > x1 ? 1 : -1;
    root.appendChild(
      el("path", {
        class: "msg-line",
        d: `M${x1},${yy} L${x2 - dir * 6},${yy}`,
        stroke: color,
        "stroke-dasharray": m.kind === "prompt" ? null : "4 3",
      }),
    );
    root.appendChild(
      el("path", {
        d: `M${x2},${yy} l${-dir * 6},-3.5 l0,7 z`,
        fill: color,
      }),
    );
    root.appendChild(
      el(
        "text",
        { class: "msg-text", x: (x1 + x2) / 2, y: yy - 5, "text-anchor": "middle" },
        clip(m.label, 22),
      ),
    );
  }
}

// ── pan / zoom ────────────────────────────────────────────────────────────

const svg = document.getElementById("svg");
const viewport = document.getElementById("viewport");
const canvas = document.getElementById("canvas");

function applyTransform() {
  const { x, y, k } = state.transform;
  viewport.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
}

function fit() {
  let box;
  try {
    box = viewport.getBBox();
  } catch {
    return;
  }
  if (!box || !box.width || !box.height) return;
  const r = canvas.getBoundingClientRect();
  const pad = 40;

  // A wide fan-out (40+ siblings) is thousands of pixels tall. Scaling that to
  // fit would shrink every card into an unreadable sliver, so clamp the zoom
  // and let the overflowing axis be panned instead.
  const MIN_K = 0.6;
  const raw = Math.min(
    (r.width - pad * 2) / box.width,
    (r.height - pad * 2) / box.height,
  );
  const k = Math.min(1.15, Math.max(MIN_K, raw));

  const fitsX = box.width * k <= r.width - pad * 2;
  const fitsY = box.height * k <= r.height - pad * 2;
  state.transform = {
    k,
    x: fitsX ? pad - box.x * k + (r.width - pad * 2 - box.width * k) / 2 : pad - box.x * k,
    y: fitsY ? pad - box.y * k + (r.height - pad * 2 - box.height * k) / 2 : pad - box.y * k,
  };
  applyTransform();
}

let drag = null;
canvas.addEventListener("mousedown", (e) => {
  drag = { x: e.clientX, y: e.clientY, tx: state.transform.x, ty: state.transform.y };
  canvas.classList.add("dragging");
});
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  state.transform.x = drag.tx + (e.clientX - drag.x);
  state.transform.y = drag.ty + (e.clientY - drag.y);
  applyTransform();
});
window.addEventListener("mouseup", () => {
  drag = null;
  canvas.classList.remove("dragging");
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const k = Math.min(3, Math.max(0.08, state.transform.k * factor));
    // Keep the point under the cursor anchored while zooming.
    state.transform.x = mx - ((mx - state.transform.x) * k) / state.transform.k;
    state.transform.y = my - ((my - state.transform.y) * k) / state.transform.k;
    state.transform.k = k;
    applyTransform();
  },
  { passive: false },
);

canvas.addEventListener("click", () => select(null));
document.getElementById("fit").addEventListener("click", fit);

// ── render orchestration ──────────────────────────────────────────────────

function render() {
  const g = state.graph;
  viewport.replaceChildren();
  document.getElementById("placeholder").hidden = !!g;
  document.querySelector(".canvas-hint").hidden = !g;
  if (!g) return;

  if (state.view === "tree") renderTree(g, viewport);
  else if (state.view === "timeline") renderTimeline(g, viewport);
  else renderSequence(g, viewport);

  if (state.fitPending) {
    state.fitPending = false;
    requestAnimationFrame(fit);
  } else {
    applyTransform();
  }
  renderHeader(g);
  renderLegend(g);
  renderDrawer();
}

function renderHeader(g) {
  document.getElementById("run-project").textContent =
    (g.cwd || g.project || "").split("/").pop() || g.project;
  document.getElementById("run-index").textContent = g.sessionId.slice(0, 8).toUpperCase();
  const status = document.getElementById("run-status");
  status.textContent = g.status;
  status.className = `status-chip ${g.status}`;
  const started = g.startedAt ? new Date(g.startedAt).toLocaleString() : "—";
  document.getElementById("run-meta").textContent =
    `${g.gitBranch || "no branch"}  /  started ${started}`;

  const elapsed =
    g.startedAt && (g.endedAt || g.status === "running")
      ? (g.endedAt ? Date.parse(g.endedAt) : Date.now()) - Date.parse(g.startedAt)
      : null;

  document.getElementById("stat-agents").textContent = g.totals.agents;
  document.getElementById("stat-tokens").textContent = fmtTokens(g.totals.tokens.total);
  document.getElementById("stat-cost").textContent = fmtUsd(g.totals.costUsd);
  document.getElementById("stat-elapsed").textContent = elapsed ? fmtDur(elapsed) : "—";
}

function renderLegend(g) {
  const seen = new Map();
  for (const a of g.agents) {
    const label = modelShort(a.model);
    if (!seen.has(label)) seen.set(label, modelColor(a.model));
  }
  const box = document.getElementById("legend");
  box.replaceChildren();
  for (const [label, color] of [...seen].slice(0, 5)) {
    const s = document.createElement("span");
    const i = document.createElement("i");
    i.style.background = color;
    s.append(i, document.createTextNode(label));
    box.appendChild(s);
  }
}

// ── drawer ────────────────────────────────────────────────────────────────

function select(id) {
  state.selectedId = id === state.selectedId ? null : id;
  render();
}

function renderDrawer() {
  const drawer = document.getElementById("drawer");
  const a = state.graph?.agents.find((x) => x.id === state.selectedId);
  if (!a) {
    drawer.hidden = true;
    return;
  }
  drawer.hidden = false;

  document.getElementById("d-name").textContent = a.name;
  const statusMark = document.getElementById("d-status");
  statusMark.style.color = statusColor(a.status);
  statusMark.title = a.status;
  document.getElementById("d-sub").textContent =
    `${a.subagentType || a.nameSource} · ${a.model || "unknown model"}${a.effort ? ` · ${a.effort} effort` : ""}`;

  const rows = [
    ["status", a.status],
    ["tokens", fmtTokens(a.tokens.total)],
    ["cost", fmtUsd(a.unpricedModel ? null : a.costUsd)],
    ["duration", fmtDur(a.activeMs)],
    ["tool calls", a.toolCalls],
    ["subtree", `${a.subtree.agents} agents · ${fmtUsd(a.subtree.costUsd)}`],
  ];
  const dl = document.getElementById("d-stats");
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const cell = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    if (k === "status") dd.style.color = statusColor(a.status);
    cell.append(dt, dd);
    dl.appendChild(cell);
  }

  // Cache-aware breakdown — the whole point is showing that cache reads
  // dominate the raw token count while costing a tenth of the rate.
  const t = a.tokens;
  const parts = [
    ["input", t.input, CSSVAR("--m-other")],
    ["output", t.output, CSSVAR("--m-opus")],
    ["cache write", t.cacheCreate5m + t.cacheCreate1h, CSSVAR("--m-sonnet")],
    ["cache read", t.cacheRead, CSSVAR("--m-haiku")],
  ];
  const max = Math.max(1, ...parts.map((p) => p[1]));
  const bars = document.getElementById("d-bars");
  bars.replaceChildren();
  for (const [label, value, color] of parts) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const l = document.createElement("span");
    l.textContent = label;
    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("div");
    fill.className = "fill";
    fill.style.width = `${(value / max) * 100}%`;
    fill.style.background = color;
    track.appendChild(fill);
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = fmtTokens(value);
    row.append(l, track, val);
    bars.appendChild(row);
  }

  document.getElementById("d-prompt").textContent = a.prompt || "—";
}

document.getElementById("drawer-close").addEventListener("click", () => select(null));

// ── sessions + live feed ──────────────────────────────────────────────────

function sessionButton(s, index) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.dataset.index = String(index + 1).padStart(2, "0");
  if (s.sessionId === state.sessionId) b.classList.add("on");

  const copy = document.createElement("span");
  copy.className = "session-copy";

  const proj = document.createElement("span");
  proj.className = "proj";
  proj.textContent = s.project.replace(/^-/, "").replace(/-/g, "/");

  const when = document.createElement("span");
  when.className = "when";
  if (s.live) {
    const dot = document.createElement("i");
    dot.className = "live-dot";
    when.appendChild(dot);
  }
  when.append(document.createTextNode(`${fmtAgo(s.updatedAt)} · ${s.sessionId.slice(0, 8)}`));
  if (s.hasSubagents) {
    const agents = document.createElement("span");
    agents.className = "has-agents";
    agents.textContent = " / agents";
    when.appendChild(agents);
  }

  copy.append(proj, when);
  b.appendChild(copy);
  b.addEventListener("click", () => openSession(s.sessionId));
  li.appendChild(b);
  return li;
}

async function loadSessions() {
  let data;
  try {
    data = await (await fetch("/api/sessions")).json();
  } catch {
    return;
  }
  const activeList = document.getElementById("sessions-active");
  const recentList = document.getElementById("sessions-recent");
  activeList.replaceChildren(...data.active.map(sessionButton));
  recentList.replaceChildren(...data.recent.map(sessionButton));
  document.getElementById("active-count").textContent = String(data.active.length).padStart(2, "0");
  document.getElementById("recent-count").textContent = String(data.recent.length).padStart(2, "0");
  document.getElementById("active-empty").hidden = data.active.length > 0;

  // Auto-open the newest live session on first load.
  if (!state.sessionId && data.active.length) openSession(data.active[0].sessionId);
}

function setConn(on, label) {
  const c = document.getElementById("conn");
  c.classList.toggle("on", on);
  c.querySelector("em").textContent = label;
}

function openSession(sessionId) {
  if (state.source) state.source.close();
  state.sessionId = sessionId;
  state.selectedId = null;
  state.fitPending = true;
  setConn(false, "connecting");

  const src = new EventSource(`/live?session=${encodeURIComponent(sessionId)}`);
  state.source = src;

  src.addEventListener("graph", (e) => {
    const g = JSON.parse(e.data);
    if (g.error) {
      setConn(false, "error");
      return;
    }
    state.graph = g;
    setConn(g.status === "running", g.status === "running" ? "live" : "connected");
    render();
  });
  src.onerror = () => setConn(false, "reconnecting");

  loadSessions();
}

// ── tabs ──────────────────────────────────────────────────────────────────

for (const btn of document.querySelectorAll('[role="tab"]')) {
  btn.addEventListener("click", () => {
    document.querySelectorAll('[role="tab"]').forEach((b) => {
      b.classList.remove("on");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("on");
    btn.setAttribute("aria-selected", "true");
    state.view = btn.dataset.view;
    state.fitPending = true;
    render();
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") select(null);
  if (e.key === "f") fit();
});

loadSessions();
setInterval(loadSessions, 15000);
