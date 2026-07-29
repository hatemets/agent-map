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
  autoFit: true,
  topologyKey: null,
  focusDrawer: false,
  restoreAgentId: null,
  appVersion: null,
  collapsedProjects: new Set(),
  projectDisclosureInitialized: false,
};

// ── formatting ────────────────────────────────────────────────────────────

const fmtTokens = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n | 0}`;

const fmtUsd = (n) =>
  n == null ? "—" : n >= 10 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;

const fmtCost = (n, unpriced = false) => (unpriced ? "unpriced" : fmtUsd(n));

/** Normalizes activity emitted by an older in-memory server during hot reload. */
const displayActivity = (activity) => String(activity || "").replace(/\s*—\s*/g, ": ");

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

function makeAgentInteractive(g, agent) {
  g.dataset.agentId = agent.id;
  g.setAttribute("role", "button");
  g.setAttribute("tabindex", "0");
  g.setAttribute(
    "aria-label",
    `${agent.name}, ${agent.status}, ${modelShort(agent.model)}, ${fmtTokens(agent.tokens.total)} tokens`,
  );
  g.appendChild(el("title", {}, `${agent.name}: ${displayActivity(agent.activity || agent.status)}`));
  g.addEventListener("click", (event) => {
    if (suppressCanvasClick) return;
    event.stopPropagation();
    select(agent.id, true);
  });
  g.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    select(agent.id, true);
  });
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
const NODE_H = 64;
const TREE_GAP_X = 36;
const TREE_GAP_Y = 86;
const FANOUT_GAP_X = 12;

function renderTree(graph, root) {
  const { order, kids } = orderedAgents(graph);
  const { pos, metrics } = topDownLayout(order, kids);

  const links = el("g");
  for (const agent of order) {
    if (!agent.parentId || !pos.has(agent.parentId)) continue;
    const parent = pos.get(agent.parentId);
    const child = pos.get(agent.id);
    const parentMetric = metrics.get(agent.parentId);
    const childMetric = metrics.get(agent.id);
    const startY = parent.y + parentMetric.h / 2;
    const endY = child.y - childMetric.h / 2;
    const channelY = startY + (endY - startY) / 2;
    links.appendChild(
      el("path", {
        class: `link${agent.inferred ? " inferred" : ""}`,
        d: `M${parent.x},${startY} V${channelY} H${child.x} V${endY}`,
      }),
    );
  }
  root.appendChild(links);

  for (const agent of order) {
    const point = pos.get(agent.id);
    const metric = metrics.get(agent.id);
    const g = el("g", {
      class: `node${metric.compact ? " compact" : ""}${agent.id === state.selectedId ? " sel" : ""}`,
      transform: `translate(${point.x - metric.w / 2},${point.y - metric.h / 2})`,
    });
    makeAgentInteractive(g, agent);
    g.appendChild(el("rect", { class: "node-card", width: metric.w, height: metric.h }));
    g.appendChild(
      el("circle", {
        cx: metric.compact ? 11 : 15,
        cy: metric.compact ? metric.h / 2 : 17,
        r: 3.5,
        fill: statusColor(agent.status),
        class: agent.status === "running" ? "bar running" : null,
      }),
    );
    if (metric.compact) {
      g.appendChild(el("text", { class: "node-name", x: 20, y: metric.h / 2 + 4 }, clip(agent.name, metric.labelChars)));
    } else {
      g.appendChild(el("text", { class: "node-name", x: 26, y: 22 }, clip(agent.name, 27)));
      g.appendChild(el("text", { class: "node-activity", x: 12, y: 42 }, clip(displayActivity(agent.activity), 36)));
      g.appendChild(
        el(
          "text",
          { class: "node-meta", x: 12, y: 57 },
          `${modelShort(agent.model)} · ${fmtTokens(agent.tokens.total)} · ${fmtCost(agent.costUsd, agent.unpricedModel)}`,
        ),
      );
    }
    root.appendChild(g);
  }
}

/**
 * Lay the graph out top-down. A large root-level leaf fan-out uses one compact
 * row so each edge gets its own vertical terminal and stays visible.
 */
function topDownLayout(order, kids) {
  const root = order.find((agent) => !agent.parentId);
  const children = root ? kids.get(root.id) || [] : [];
  const metrics = new Map(order.map((agent) => [agent.id, { w: NODE_W, h: NODE_H, compact: false, labelChars: 27 }]));
  const pos = new Map();
  const fanout = children.length >= 4 && children.every((agent) => !(kids.get(agent.id) || []).length);

  if (fanout) {
    const rect = canvas.getBoundingClientRect();
    const available = Math.max(1, rect.width * 0.8 - (children.length - 1) * FANOUT_GAP_X);
    const width = Math.max(92, Math.min(174, available / children.length));
    const height = 48;
    for (const child of children) {
      metrics.set(child.id, {
        w: width,
        h: height,
        compact: true,
        labelChars: Math.max(10, Math.floor((width - 20) / 6.2)),
      });
    }
    const firstX = width / 2;
    children.forEach((child, index) => {
      pos.set(child.id, { x: firstX + index * (width + FANOUT_GAP_X), y: NODE_H + TREE_GAP_Y + height / 2 });
    });
    pos.set(root.id, {
      x: (pos.get(children[0].id).x + pos.get(children[children.length - 1].id).x) / 2,
      y: NODE_H / 2,
    });
    return { pos, metrics };
  }

  let leaf = 0;
  const layout = (agent) => {
    const descendants = kids.get(agent.id) || [];
    if (!descendants.length) {
      pos.set(agent.id, { x: leaf++ * (NODE_W + TREE_GAP_X), y: agent.depth * (NODE_H + TREE_GAP_Y) });
      return;
    }
    descendants.forEach(layout);
    const first = pos.get(descendants[0].id).x;
    const last = pos.get(descendants[descendants.length - 1].id).x;
    pos.set(agent.id, { x: (first + last) / 2, y: agent.depth * (NODE_H + TREE_GAP_Y) });
  };
  if (root) layout(root);
  for (const agent of order) {
    if (!pos.has(agent.id)) pos.set(agent.id, { x: leaf++ * (NODE_W + TREE_GAP_X), y: agent.depth * (NODE_H + TREE_GAP_Y) });
  }
  return { pos, metrics };
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
    makeAgentInteractive(g, a);
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
    root.appendChild(g);
  });
}

// ── view: sequence ────────────────────────────────────────────────────────

const SEQ_TOP = 70;
const SEQ_GUTTER = 74;
const SEQ_ROW_H = 42;

function renderSequence(graph, root) {
  const { order } = orderedAgents(graph);
  const [t0] = timeExtent(graph, order);
  const messages = graph.messages
    .map((message, index) => ({ ...message, index, time: Date.parse(message.at) }))
    .filter((message) => Number.isFinite(message.time))
    .sort((a, b) => a.time - b.time || a.index - b.index);
  const rect = canvas.getBoundingClientRect();
  const availableWidth = Math.max(620, rect.width - SEQ_GUTTER - 36);
  const laneGap = order.length > 1
    ? Math.max(148, availableWidth / (order.length - 1))
    : 170;
  const drawingWidth = SEQ_GUTTER + Math.max(1, order.length - 1) * laneGap + 24;
  const headerWidth = Math.min(168, Math.max(132, laneGap - 16));
  const sequenceHeight = Math.max(
    460,
    messages.length * SEQ_ROW_H + 46,
    rect.height - SEQ_TOP - 92,
  );
  const colOf = new Map(order.map((agent, index) => [agent.id, SEQ_GUTTER + index * laneGap]));

  // Lifelines + headers.
  order.forEach((a) => {
    const x = colOf.get(a.id);
    root.appendChild(
      el("line", { class: "lifeline", x1: x, y1: SEQ_TOP, x2: x, y2: SEQ_TOP + sequenceHeight }),
    );
    const g = el("g", { class: "node sequence-head", transform: `translate(${x - headerWidth / 2},0)` });
    makeAgentInteractive(g, a);
    g.appendChild(el("rect", { class: "node-card", width: headerWidth, height: 50 }));
    g.appendChild(
      el("rect", { x: 0, y: 0, width: 4, height: 50, fill: modelColor(a.model), rx: 2 }),
    );
    g.appendChild(el("text", { class: "node-name", x: 12, y: 21 }, clip(a.name, Math.floor((headerWidth - 20) / 7))));
    g.appendChild(el("text", { class: "node-meta", x: 12, y: 38 }, modelShort(a.model)));
    root.appendChild(g);
  });

  // Timestamp collisions are common around dispatch/result records. Give every
  // event a chronological row, and preserve real timing in the left gutter.
  messages.forEach((m, index) => {
    const x1 = colOf.get(m.from);
    const x2 = colOf.get(m.to);
    if (x1 === undefined || x2 === undefined) return;
    const yy = SEQ_TOP + 28 + index * SEQ_ROW_H;
    const color =
      m.kind === "error"
        ? CSSVAR("--fail")
        : m.kind === "result"
          ? CSSVAR("--ink-faint")
          : CSSVAR("--m-opus");
    const dir = x2 > x1 ? 1 : -1;
    const row = el("g", { class: `message-row ${m.kind || "prompt"}` });
    row.appendChild(el("title", {}, `${m.label || m.kind || "message"} · ${fmtDur(m.time - t0)}`));
    row.appendChild(
      el("text", { class: "msg-time", x: 8, y: yy + 3 }, `${String(index + 1).padStart(2, "0")}  +${fmtDur(Math.max(0, m.time - t0))}`),
    );
    row.appendChild(
      el("path", {
        class: "msg-line",
        d: `M${x1},${yy} L${x2 - dir * 6},${yy}`,
        stroke: color,
        "stroke-dasharray": m.kind === "prompt" ? null : "4 3",
      }),
    );
    row.appendChild(
      el("circle", { class: "msg-origin", cx: x1, cy: yy, r: 2.5, fill: color }),
    );
    row.appendChild(
      el("path", {
        d: `M${x2},${yy} l${-dir * 6},-3.5 l0,7 z`,
        fill: color,
      }),
    );
    const rawLabel = m.kind === "result" ? "Returned" : m.kind === "error" ? (m.label || "Failed") : m.label;
    const label = clip(rawLabel || "Message", 28);
    const labelWidth = Math.min(176, Math.max(58, label.length * 5.3 + 18));
    const labelX = (x1 + x2) / 2;
    row.appendChild(
      el("rect", {
        class: "msg-label-bg",
        x: labelX - labelWidth / 2,
        y: yy - 14,
        width: labelWidth,
        height: 20,
        rx: 5,
      }),
    );
    row.appendChild(
      el(
        "text",
        { class: `msg-text ${m.kind || "prompt"}`, x: labelX, y: yy, "text-anchor": "middle" },
        label,
      ),
    );
    root.appendChild(row);
  });
}

// ── pan / zoom ────────────────────────────────────────────────────────────

const svg = document.getElementById("svg");
const viewport = document.getElementById("viewport");
const canvas = document.getElementById("canvas");

function applyTransform() {
  const { x, y, k } = state.transform;
  viewport.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
}

let transformFrame = null;

function stopTransformAnimation() {
  if (transformFrame !== null) cancelAnimationFrame(transformFrame);
  transformFrame = null;
}

function setTransform(next, { animate = false } = {}) {
  stopTransformAnimation();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduced) {
    state.transform = next;
    applyTransform();
    return;
  }

  const from = { ...state.transform };
  const startedAt = performance.now();
  const duration = 220;
  const step = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - (1 - progress) ** 3;
    state.transform = {
      x: from.x + (next.x - from.x) * eased,
      y: from.y + (next.y - from.y) * eased,
      k: from.k + (next.k - from.k) * eased,
    };
    applyTransform();
    if (progress < 1) transformFrame = requestAnimationFrame(step);
    else transformFrame = null;
  };
  transformFrame = requestAnimationFrame(step);
}

function fit({ animate = true } = {}) {
  let box;
  try {
    box = viewport.getBBox();
  } catch {
    return;
  }
  if (!box || !box.width || !box.height) return;
  const r = canvas.getBoundingClientRect();
  const padX = r.width * 0.1;
  const padY = r.height * 0.1;
  const raw = Math.min(
    (r.width - padX * 2) / box.width,
    (r.height - padY * 2) / box.height,
  );
  const k = Math.max(0.08, raw);

  const fitsX = box.width * k <= r.width - padX * 2;
  const fitsY = box.height * k <= r.height - padY * 2;
  setTransform({
    k,
    x: fitsX ? padX - box.x * k + (r.width - padX * 2 - box.width * k) / 2 : padX - box.x * k,
    y: fitsY ? padY - box.y * k + (r.height - padY * 2 - box.height * k) / 2 : padY - box.y * k,
  }, { animate });
}

let drag = null;
let suppressCanvasClick = false;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  // A node is a control, not a pan handle. Starting a canvas drag here made a
  // barely perceptible trackpad movement suppress the node's click event.
  if (e.target.closest?.("[data-agent-id]")) return;
  stopTransformAnimation();
  drag = {
    pointerId: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    tx: state.transform.x,
    ty: state.transform.y,
    moved: false,
  };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag || drag.pointerId !== e.pointerId) return;
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) {
    drag.moved = true;
    state.autoFit = false;
  }
  state.transform.x = drag.tx + (e.clientX - drag.x);
  state.transform.y = drag.ty + (e.clientY - drag.y);
  applyTransform();
});
const endDrag = (e) => {
  if (!drag || drag.pointerId !== e.pointerId) return;
  suppressCanvasClick = drag.moved;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  drag = null;
  canvas.classList.remove("dragging");
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    stopTransformAnimation();
    state.autoFit = false;
    const k = Math.min(3, Math.max(0.08, state.transform.k * factor));
    // Keep the point under the cursor anchored while zooming.
    state.transform.x = mx - ((mx - state.transform.x) * k) / state.transform.k;
    state.transform.y = my - ((my - state.transform.y) * k) / state.transform.k;
    state.transform.k = k;
    applyTransform();
  },
  { passive: false },
);

canvas.addEventListener("click", () => {
  if (suppressCanvasClick) {
    suppressCanvasClick = false;
    return;
  }
  select(null);
});
document.getElementById("fit").addEventListener("click", () => {
  state.autoFit = true;
  fit();
});

function zoomBy(factor) {
  if (!state.graph) return;
  stopTransformAnimation();
  state.autoFit = false;
  const r = canvas.getBoundingClientRect();
  const mx = r.width / 2;
  const my = r.height / 2;
  const previous = state.transform.k;
  const k = Math.min(3, Math.max(0.08, previous * factor));
  state.transform.x = mx - ((mx - state.transform.x) * k) / previous;
  state.transform.y = my - ((my - state.transform.y) * k) / previous;
  state.transform.k = k;
  applyTransform();
}

document.getElementById("zoom-in").addEventListener("click", () => zoomBy(1.2));
document.getElementById("zoom-out").addEventListener("click", () => zoomBy(1 / 1.2));

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
    requestAnimationFrame(() => fit());
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
  document.getElementById("stat-cost").textContent = fmtCost(
    g.totals.costUsd,
    g.totals.unpriced,
  );
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

function select(id, focusDrawer = false) {
  const closing = !id || id === state.selectedId;
  if (!closing) state.restoreAgentId = id;
  state.selectedId = id === state.selectedId ? null : id;
  state.focusDrawer = !closing && focusDrawer;
  render();
  if (closing && state.restoreAgentId) {
    requestAnimationFrame(() => {
      document.querySelector(`[data-agent-id="${CSS.escape(state.restoreAgentId)}"]`)?.focus();
    });
  }
}

function renderDrawer() {
  const drawer = document.getElementById("drawer");
  const a = state.graph?.agents.find((x) => x.id === state.selectedId);
  if (!a) {
    state.selectedId = null;
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
    ["cost", fmtCost(a.costUsd, a.unpricedModel)],
    ["duration", fmtDur(a.activeMs)],
    ["tool calls", a.toolCalls],
    ["subtree", `${a.subtree.agents} agents · ${fmtCost(a.subtree.costUsd, a.subtree.unpriced)}`],
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

  if (state.focusDrawer) {
    state.focusDrawer = false;
    requestAnimationFrame(() => document.getElementById("drawer-close").focus());
  }
}

document.getElementById("drawer-close").addEventListener("click", () => select(null));

// ── sessions + live feed ──────────────────────────────────────────────────

/** Project-directory slugs encode the path; the project tail is the useful label. */
function projectName(project) {
  const marker = "-projects-";
  const at = project.lastIndexOf(marker);
  const tail = at >= 0 ? project.slice(at + marker.length) : project.replace(/^-/, "");
  return tail || "unknown project";
}

function sessionButton(s) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  if (s.sessionId === state.sessionId) b.classList.add("on");

  const copy = document.createElement("span");
  copy.className = "session-copy";

  const proj = document.createElement("span");
  proj.className = "proj";
  const title = s.title || "No opening request";
  proj.textContent = title;
  b.setAttribute("aria-label", `${projectName(s.project)}: ${title}. Session ${s.sessionId.slice(0, 8)}`);

  const when = document.createElement("span");
  when.className = "when";
  when.append(document.createTextNode(`${fmtAgo(s.updatedAt)} · ${s.sessionId.slice(0, 8)}`));
  if (s.hasSubagents) {
    const agents = document.createElement("span");
    agents.className = "has-agents";
    agents.textContent = " / agents";
    when.appendChild(agents);
  }

  copy.append(proj, when);
  b.appendChild(copy);
  if (s.live) {
    const dot = document.createElement("i");
    dot.className = "live-dot";
    dot.setAttribute("aria-hidden", "true");
    b.appendChild(dot);
  }
  b.addEventListener("click", () => openSession(s.sessionId));
  li.appendChild(b);
  return li;
}

/** A stable two-state icon avoids the layout shift of the old CSS folder. */
function projectFolderIcon() {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "project-folder");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  const closed = document.createElementNS(NS, "path");
  closed.setAttribute("class", "folder-closed");
  closed.setAttribute("d", "M3.75 6.75A1.75 1.75 0 0 1 5.5 5h4.1l2 2h6.9a1.75 1.75 0 0 1 1.75 1.75v8.75a1.75 1.75 0 0 1-1.75 1.75h-13a1.75 1.75 0 0 1-1.75-1.75Z");

  const open = document.createElementNS(NS, "path");
  open.setAttribute("class", "folder-open");
  open.setAttribute("d", "M3.75 8.25v-.5A1.75 1.75 0 0 1 5.5 6h4.1l2 2h7.25c1.2 0 2.04 1.17 1.66 2.31l-2.25 6.75a1.75 1.75 0 0 1-1.66 1.19H5.4a1.75 1.75 0 0 1-1.66-2.3l2.05-6.16A1.75 1.75 0 0 1 7.45 8.6h11.9");
  svg.append(closed, open);
  return svg;
}

/** Render sessions in project buckets, preserving the API's newest-first order. */
function groupedSessionBlocks(sessions, bucket) {
  const byProject = new Map();
  for (const session of sessions) {
    const name = projectName(session.project);
    if (!byProject.has(name)) byProject.set(name, []);
    byProject.get(name).push(session);
  }

  return [...byProject].map(([project, runs]) => {
    const projectKey = `${bucket}:${project}`;
    const collapsed = state.collapsedProjects.has(projectKey);
    const selected = runs.some((run) => run.sessionId === state.sessionId);
    const group = document.createElement("li");
    group.className = `project-group${collapsed ? " collapsed" : ""}${selected ? " selected-project" : ""}`;

    const heading = document.createElement("button");
    heading.className = "project-heading";
    heading.type = "button";
    heading.setAttribute("aria-expanded", String(!collapsed));
    heading.setAttribute("aria-controls", `project-runs-${bucket}-${projectKey.replace(/[^a-z0-9]+/gi, "-")}`);
    heading.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${project}, ${runs.length} ${runs.length === 1 ? "run" : "runs"}`);
    const title = document.createElement("span");
    title.className = "project-title";
    const folder = projectFolderIcon();
    const name = document.createElement("h3");
    name.textContent = project;
    const count = document.createElement("span");
    count.className = "project-count";
    count.textContent = `${runs.length} ${runs.length === 1 ? "run" : "runs"}`;
    title.append(folder, name);
    heading.append(title, count);
    heading.addEventListener("click", () => {
      if (state.collapsedProjects.has(projectKey)) state.collapsedProjects.delete(projectKey);
      else state.collapsedProjects.add(projectKey);
      const isCollapsed = state.collapsedProjects.has(projectKey);
      group.classList.toggle("collapsed", isCollapsed);
      heading.setAttribute("aria-expanded", String(!isCollapsed));
      heading.setAttribute("aria-label", `${state.collapsedProjects.has(projectKey) ? "Expand" : "Collapse"} ${project}, ${runs.length} ${runs.length === 1 ? "run" : "runs"}`);
    });

    const reveal = document.createElement("div");
    reveal.className = "project-runs-reveal";
    const list = document.createElement("ul");
    list.className = "project-runs";
    list.id = heading.getAttribute("aria-controls");
    list.replaceChildren(...runs.map(sessionButton));
    reveal.appendChild(list);
    group.append(heading, reveal);
    return group;
  });
}

async function loadSessions() {
  let data;
  try {
    const response = await fetch("/api/sessions");
    if (!response.ok) throw new Error(`session index returned ${response.status}`);
    data = await response.json();
    if (!Array.isArray(data.active) || !Array.isArray(data.recent)) {
      throw new Error("session index is malformed");
    }
  } catch {
    if (!state.graph) showPlaceholder("INDEX ERROR", "Run index unavailable.", "Agent Map could not read the local session index. Check the server output and retry.", true);
    setConn(false, "index error", "error");
    return;
  }
  const activeList = document.getElementById("sessions-active");
  const recentList = document.getElementById("sessions-recent");
  const autoOpen = !state.sessionId && data.active.length ? data.active[0].sessionId : null;
  if (autoOpen) state.sessionId = autoOpen;
  if (!state.projectDisclosureInitialized) {
    for (const [bucket, sessions] of [["active", data.active], ["recent", data.recent]]) {
      const projects = new Map();
      for (const session of sessions) {
        const name = projectName(session.project);
        if (!projects.has(name)) projects.set(name, []);
        projects.get(name).push(session);
      }
      for (const [project, runs] of projects) {
        if (!runs.some((run) => run.sessionId === state.sessionId)) {
          state.collapsedProjects.add(`${bucket}:${project}`);
        }
      }
    }
    state.projectDisclosureInitialized = true;
  }
  activeList.replaceChildren(...groupedSessionBlocks(data.active, "active"));
  recentList.replaceChildren(...groupedSessionBlocks(data.recent, "recent"));
  document.getElementById("active-count").textContent = String(data.active.length).padStart(2, "0");
  document.getElementById("recent-count").textContent = String(data.recent.length).padStart(2, "0");
  document.getElementById("active-empty").hidden = data.active.length > 0;

  // Auto-open the newest live session on first load.
  if (autoOpen) openSession(autoOpen);
}

function setConn(on, label, kind = "") {
  const c = document.getElementById("conn");
  c.classList.toggle("on", on);
  c.classList.toggle("warn", kind === "warn");
  c.classList.toggle("error", kind === "error");
  c.querySelector("em").textContent = label;
}

function showPlaceholder(index, title, copy, error = false) {
  state.graph = null;
  viewport.replaceChildren();
  const placeholder = document.getElementById("placeholder");
  placeholder.hidden = false;
  placeholder.classList.toggle("error", error);
  document.querySelector(".canvas-hint").hidden = true;
  document.getElementById("placeholder-index").textContent = index;
  document.getElementById("placeholder-title").textContent = title;
  document.getElementById("placeholder-copy").textContent = copy;
}

/** Reload the local dashboard when its static source files change on disk. */
async function checkAppVersion() {
  try {
    const response = await fetch("/api/app-version", { cache: "no-store" });
    if (!response.ok) return;
    const { version } = await response.json();
    if (typeof version !== "string") return;
    if (state.appVersion && state.appVersion !== version) {
      window.location.reload();
      return;
    }
    state.appVersion = version;
  } catch {
    // The normal session feed owns connection status; source polling is best-effort.
  }
}

function openSession(sessionId) {
  if (state.source) state.source.close();
  state.sessionId = sessionId;
  state.selectedId = null;
  state.autoFit = true;
  state.topologyKey = null;
  state.fitPending = true;
  setConn(false, "connecting");

  const src = new EventSource(`/live?session=${encodeURIComponent(sessionId)}`);
  state.source = src;

  src.addEventListener("graph", (e) => {
    if (src !== state.source) return;
    let g;
    try {
      g = JSON.parse(e.data);
    } catch {
      showPlaceholder("STREAM ERROR", "The live update was malformed.", "The selected run remains untouched. Agent Map rejected an invalid server event.", true);
      setConn(false, "stream error", "error");
      return;
    }
    if (g.error) {
      showPlaceholder("RUN ERROR", "This run could not be reconstructed.", g.error, true);
      setConn(false, "run error", "error");
      return;
    }
    if (!Array.isArray(g.agents) || !g.agents.length) {
      showPlaceholder("EMPTY RUN", "No agents were found.", "The selected transcript did not produce a valid run graph.", true);
      setConn(false, "empty", "warn");
      return;
    }
    const topologyKey = g.agents
      .map((agent) => `${agent.id}:${agent.parentId || ""}`)
      .sort()
      .join("|");
    if (state.autoFit && state.topologyKey && state.topologyKey !== topologyKey) {
      state.fitPending = true;
    }
    state.topologyKey = topologyKey;
    state.graph = g;
    setConn(g.status === "running", g.status === "running" ? "live" : "connected");
    render();
  });
  src.onerror = () => {
    if (src === state.source) setConn(false, "reconnecting", "warn");
  };

  loadSessions();
}

// ── tabs ──────────────────────────────────────────────────────────────────

const tabs = [...document.querySelectorAll('[role="tab"]')];

function activateTab(btn) {
  tabs.forEach((tab) => {
    tab.classList.remove("on");
    tab.setAttribute("aria-selected", "false");
    tab.setAttribute("tabindex", "-1");
  });
  btn.classList.add("on");
  btn.setAttribute("aria-selected", "true");
  btn.setAttribute("tabindex", "0");
  state.view = btn.dataset.view;
  state.fitPending = true;
  render();
}

for (const btn of tabs) {
  btn.addEventListener("click", () => {
    activateTab(btn);
  });
  btn.addEventListener("keydown", (event) => {
    const current = tabs.indexOf(btn);
    let next = null;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    activateTab(tabs[next]);
    tabs[next].focus();
  });
}

tabs.slice(1).forEach((tab) => tab.setAttribute("tabindex", "-1"));

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") select(null);
  if (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    state.autoFit = true;
    fit();
  }
});

let resizeFrame = null;
new ResizeObserver(() => {
  if (!state.graph || !state.autoFit) return;
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    state.fitPending = true;
    render();
  });
}).observe(canvas);

loadSessions();
checkAppVersion();
setInterval(loadSessions, 15000);
setInterval(checkAppVersion, 1500);
