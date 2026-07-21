#!/usr/bin/env node
/**
 * Agent Map server.
 *
 * Zero dependencies: node:http for REST + static files, Server-Sent Events for
 * the live feed. SSE rather than WebSocket because the stream is one-way
 * (server -> browser) and EventSource reconnects on its own.
 *
 *   GET  /api/sessions            recent + active sessions
 *   GET  /api/runs/:sessionId     one RunGraph
 *   GET  /live?session=<id>       SSE stream of RunGraph updates
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const { buildRunGraph } = require("./lib/graph");
const { watchSession } = require("./lib/watcher");
const {
  listAllSessions,
  listActiveSessions,
  findSession,
  projectsRoot,
} = require("./lib/discovery");

const PORT = Number(process.env.AGENT_MAP_PORT || 4830);
const CLIENT_DIR = path.join(__dirname, "..", "client");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(CLIENT_DIR, rel);
  // Never serve outside the client directory.
  if (!file.startsWith(CLIENT_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

/** Sessions list: live ones first, then recent history. */
function sessionsPayload() {
  const active = listActiveSessions();
  const activeIds = new Set(active.map((s) => s.sessionId));
  const recent = listAllSessions()
    .filter((s) => !activeIds.has(s.sessionId))
    .slice(0, 60);

  const shape = (s, live) => ({
    sessionId: s.sessionId,
    project: s.project,
    updatedAt: new Date(s.newestMtimeMs || s.mtimeMs).toISOString(),
    sizeBytes: s.sizeBytes,
    hasSubagents: s.hasSubagents,
    live,
  });

  return {
    projectsRoot: projectsRoot(),
    active: active.map((s) => shape(s, true)),
    recent: recent.map((s) => shape(s, false)),
  };
}

function handleLive(req, res, sessionId) {
  const found = findSession(sessionId);
  if (!found) {
    sendJson(res, 404, { error: `no session matching ${sessionId}` });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");

  let lastSerialized = null;
  const send = (graph) => {
    const body = JSON.stringify(graph);
    // Only push when something actually changed.
    if (body === lastSerialized) return;
    lastSerialized = body;
    res.write(`event: graph\ndata: ${body}\n\n`);
  };

  const unsubscribe = watchSession({
    projectDir: found.projectDir,
    sessionId: found.sessionId,
    onUpdate: send,
  });

  // Comment frames keep proxies and idle timeouts from closing the stream.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
  heartbeat.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", close);
  req.on("error", close);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  try {
    if (p === "/api/sessions") return sendJson(res, 200, sessionsPayload());

    if (p.startsWith("/api/runs/")) {
      const id = decodeURIComponent(p.slice("/api/runs/".length));
      const found = findSession(id);
      if (!found) return sendJson(res, 404, { error: `no session matching ${id}` });
      const graph = buildRunGraph({
        projectDir: found.projectDir,
        sessionId: found.sessionId,
      });
      return sendJson(res, 200, graph);
    }

    if (p === "/live") {
      const id = url.searchParams.get("session");
      if (!id) return sendJson(res, 400, { error: "missing ?session=" });
      return handleLive(req, res, id);
    }

    return serveStatic(res, p);
  } catch (err) {
    return sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Agent Map  →  http://localhost:${PORT}`);
  console.log(`watching   ${projectsRoot()}`);
});
