import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Session, clamp } from "./lib/session.js";
import { sendBounded, telemetry, advanceCursors } from "./lib/transport.js";
const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ tls } = {}) {
  const rooms = new Map();
  const handler = (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file =
      pathname === "/lib/signal.js"
        ? path.join(root, "lib/signal.js")
        : path.join(root, "public", pathname === "/" ? "index.html" : pathname);
    if (
      !file.startsWith(path.join(root, "public") + path.sep) &&
      pathname !== "/lib/signal.js"
    ) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      res
        .writeHead(200, {
          "Content-Type": file.endsWith(".svg")
            ? "image/svg+xml"
            : file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".css")
                ? "text/css"
                : "text/html",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .end(data);
    });
  };
  const server = tls
    ? https.createServer(tls, handler)
    : http.createServer(handler);
  const wss = new WebSocketServer({ server, maxPayload: 24000 });
  const send = sendBounded;
  const publish = (room, hydrate = false) => {
    const snapshot = room.snapshot({ points: hydrate });
    for (const peer of wss.clients) {
      if (peer.room !== room) continue;
      const payload =
        peer.role === "host"
          ? snapshot
          : {
              code: room.code,
              settings: room.settings,
              simulation: room.simulation,
              events: [],
              devices: snapshot.devices
                .filter((d) => d.id === peer.deviceId)
                .map((d) => ({ ...d, points: [] })),
            };
      send(peer, { type: "state", ...payload });
    }
  };
  const impact = (room) => {
    const now = Date.now();
    for (const d of room.devices.values())
      if (d.virtual) {
        const t = Math.max(now, (d.signal.lastTime || 0) + 1);
        d.signal.last = -Infinity;
        room.ingest(d.id, [{ t, m: 11.2 }], t);
      }
  };
  wss.on("connection", (ws) => {
    ws.cursors = new Map();
    ws.mode = "performance";
    ws.pendingEvents = [];
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    let quota = 0,
      quotaAt = Date.now();
    ws.on("message", (raw) => {
      try {
        if (Date.now() - quotaAt > 1000) {
          quota = 0;
          quotaAt = Date.now();
        }
        if (++quota > 260) throw Error("Too many messages.");
        const m = JSON.parse(raw);
        if (!m || typeof m !== "object") throw Error("Invalid message.");
        if (m.type === "ping") {
          send(ws, { type: "pong", sent: m.sent, server: Date.now() });
          return;
        }
        if (m.type === "create") {
          if (ws.room) throw Error("Already joined.");
          if (rooms.size >= 50) throw Error("Server room limit reached.");
          let code;
          do {
            code = Math.random().toString(36).slice(2, 8).toUpperCase();
          } while (rooms.has(code));
          const room = new Session(code, (event) => {
            for (const peer of wss.clients)
              if (peer.room === room && peer.role === "host") {
                if (!send(peer, { type: "event", event }))
                  peer.pendingEvents = [...peer.pendingEvents, event].slice(
                    -40,
                  );
              }
          });
          rooms.set(code, room);
          ws.room = room;
          ws.role = "host";
          send(ws, { type: "created", code, token: room.hostToken });
          publish(room);
          return;
        }
        if (m.type === "join") {
          if (ws.room) throw Error("Already joined.");
          const room = rooms.get(String(m.code).toUpperCase());
          if (!room)
            throw Error("Room not found. Create a new room on the host.");
          if (m.role === "host") {
            if (m.token !== room.hostToken)
              throw Error("Invalid host credential.");
            ws.role = "host";
          } else {
            let d = [...room.devices.values()].find(
              (d) => d.secret === m.token,
            );
            if (d?.virtual) d = null;
            if (!d) d = room.join(m.name, m.position);
            for (const other of wss.clients)
              if (
                other !== ws &&
                other.deviceId === d.id &&
                other.room === room
              )
                other.close();
            d.connected = true;
            ws.deviceId = d.id;
            ws.role = "phone";
            send(ws, { type: "joined", token: d.secret, code: room.code });
          }
          ws.room = room;
          room.lastActive = Date.now();
          publish(room, true);
          return;
        }
        const room = ws.room;
        if (!room) throw Error("Join a room first.");
        if (m.type === "mode")
          ws.mode = m.mode === "eco" ? "eco" : "performance";
        if (m.type === "samples" && ws.role === "phone")
          room.ingest(ws.deviceId, m.samples);
        if (m.type === "sync" && ws.role === "phone") {
          const d = room.devices.get(ws.deviceId);
          if (d && Number.isFinite(m.uncertainty) && Number.isFinite(m.rtt))
            d.sync = {
              uncertainty: clamp(m.uncertainty, 0, 10000),
              rtt: clamp(m.rtt, 0, 10000),
            };
        }
        if (m.type === "position" && ws.role === "phone") {
          const d = room.devices.get(ws.deviceId);
          if (d) {
            d.x = clamp(m.x, 0, 4);
            d.y = clamp(m.y, 0, 4);
          }
        }
        if (m.type === "pause" && ws.role === "phone") {
          const d = room.devices.get(ws.deviceId);
          if (d) {
            d.points = [];
            d.rate = 0;
          }
        }
        if (ws.role === "host") {
          if (m.type === "settings")
            room.settings = {
              threshold: clamp(m.threshold, 2, 12),
              windowMs: clamp(m.windowMs, 50, 500),
            };
          if (m.type === "simulation") {
            for (const peer of wss.clients)
              if (peer.room === room) peer.cursors.clear();
            room.simulation = !!m.enabled;
            room.tick = 0;
            room.seed = 42;
            room.detector.pending = [];
            if (room.simulation) {
              for (let i = 0; i < 4; i++) {
                const id = "virtual-" + i;
                if (!room.devices.has(id)) {
                  const d = room.join(
                    ["Northwest", "Northeast", "Southwest", "Southeast"][i],
                    { x: (i % 2) * 3 + 0.5, y: Math.floor(i / 2) * 3 + 0.5 },
                    id,
                  );
                  d.virtual = true;
                  d.sync = { uncertainty: 0, rtt: 0 };
                  room.ingest(id, [{ t: Date.now() - 1, m: 9.81 }]);
                }
              }
            } else
              for (const [id, d] of room.devices)
                if (d.virtual) room.devices.delete(id);
            if (room.simulation) {
              room.detector.last = -Infinity;
              impact(room);
            }
          }
          if (m.type === "impact" && room.simulation) {
            room.detector.pending = [];
            room.detector.last = -Infinity;
            impact(room);
          }
        }
        if (
          ["simulation", "settings", "position", "pause", "sync"].includes(
            m.type,
          )
        )
          publish(room, m.type === "simulation");
      } catch (e) {
        send(ws, { type: "error", message: e.message });
      }
    });
    ws.on("close", () => {
      const d = ws.room?.devices.get(ws.deviceId);
      if (
        d &&
        ![...wss.clients].some(
          (other) =>
            other !== ws &&
            other.readyState === WebSocket.OPEN &&
            other.room === ws.room &&
            other.deviceId === ws.deviceId,
        )
      ) {
        d.connected = false;
        d.points = [];
        d.rate = 0;
        d.lastSeen = Date.now();
        ws.room.detector.pending = ws.room.detector.pending.filter(
          (p) => p.id !== d.id,
        );
        publish(ws.room);
      }
    });
  });
  const simulation = setInterval(() => {
    for (const room of rooms.values())
      if (room.simulation) {
        room.tick++;
        const now = Date.now();
        const phase = room.tick % 150;
        for (const [id, d] of room.devices)
          if (d.virtual) {
            const i = Number(id.at(-1));
            room.seed = (room.seed * 1664525 + 1013904223) >>> 0;
            const noise = (room.seed / 4294967296 - 0.5) * 0.045;
            const pulse =
              phase === 20 + i || room.tick === room.impactAt + i
                ? 1.3 - i * 0.15
                : 0;
            room.ingest(id, [{ t: now, m: 9.81 + noise + pulse }], now);
          }
      }
  }, 20);
  const broadcast = setInterval(() => {
    for (const room of rooms.values()) publish(room);
  }, 1000);
  const stream = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (!ws.room || ws.role !== "host") continue;
      if (
        ws.pendingEvents.length &&
        send(ws, { type: "events", events: ws.pendingEvents })
      )
        ws.pendingEvents = [];
      if (now - (ws.lastTelemetry || 0) < (ws.mode === "eco" ? 100 : 10))
        continue;
      const delta = telemetry(ws.room, ws.cursors);
      if (delta.devices.length && send(ws, delta)) {
        advanceCursors(ws.cursors, delta);
        ws.lastTelemetry = now;
      }
    }
  }, 10);
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [code, r] of rooms) {
      for (const [id, d] of r.devices)
        if (!d.connected && now - d.lastSeen > 60000) r.devices.delete(id);
      const active = [...wss.clients].some((ws) => ws.room === r);
      if (!active && now - (r.emptySince ??= now) > 60000) rooms.delete(code);
      if (active) r.emptySince = null;
    }
    for (const ws of wss.clients) {
      for (const id of ws.cursors.keys())
        if (!ws.room?.devices.has(id)) ws.cursors.delete(id);
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 15000);
  return {
    server,
    rooms,
    close: () => {
      clearInterval(simulation);
      clearInterval(broadcast);
      clearInterval(stream);
      clearInterval(cleanup);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tls =
    process.env.TLS_CERT && process.env.TLS_KEY
      ? {
          cert: fs.readFileSync(process.env.TLS_CERT),
          key: fs.readFileSync(process.env.TLS_KEY),
        }
      : undefined;
  const app = createApp({ tls });
  const port = Number(process.env.PORT) || 3000;
  app.server.listen(port, "0.0.0.0", () =>
    console.log(
      `RoomQuake running on ${tls ? "https" : "http"}://localhost:${port}`,
    ),
  );
}
