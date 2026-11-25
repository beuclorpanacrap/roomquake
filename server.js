import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Session, clamp } from "./lib/session.js";
import { sendBounded, telemetry, advanceCursors } from "./lib/transport.js";
import { renderQrSvg } from "./lib/qr.js";
import {
  beepBeepDistance,
  combinePairwiseMatrices,
  fitRelativeLayout2D,
} from "./lib/acoustics.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, "public");
const ALLOWED_LIB = new Set([
  "/lib/signal.js",
  "/lib/qr.js",
  "/lib/acoustics.js",
]);

export function createApp({ tls } = {}) {
  const rooms = new Map();
  const handler = (req, res) => {
    const reqUrl = new URL(req.url, "http://localhost");
    const pathname = reqUrl.pathname;

    if (pathname === "/qr.svg") {
      const text = reqUrl.searchParams.get("text") || "";
      if (!text) {
        res.writeHead(400).end("Missing text");
        return;
      }
      try {
        const svg = renderQrSvg(text);
        res
          .writeHead(200, {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          })
          .end(svg);
      } catch (err) {
        res.writeHead(400).end(err.message);
      }
      return;
    }

    const file = ALLOWED_LIB.has(pathname)
      ? path.join(root, pathname.slice(1))
      : path.join(publicRoot, pathname === "/" ? "index.html" : pathname);
    if (
      !file.startsWith(publicRoot + path.sep) &&
      !ALLOWED_LIB.has(pathname)
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
              layout: snapshot.layout,
              events: [],
              devices: snapshot.devices
                .filter((d) => d.id === peer.deviceId)
                .map((d) => ({ ...d, points: [] })),
            };
      send(peer, { type: "state", ...payload });
    }
  };
  const sendToHosts = (room, msg) => {
    for (const peer of wss.clients) {
      if (peer.room === room && peer.role === "host") send(peer, msg);
    }
  };
  const impact = (room) => {
    const now = Date.now();
    for (const d of room.devices.values())
      if (d.virtual) {
        const t = Math.max(now, (d.signal.lastTime || 0) + 1);
        d.signal.last = -Infinity;
        d.signal.envelope = 0;
        d.signal.armed = true;
        room.ingest(d.id, [{ t, m: 11.2 }], t);
      }
  };

  const finalizeCalibration = (room) => {
    const cal = room.calibration;
    if (!cal) return;
    clearTimeout(cal.timer);
    room.calibration = null;
    const ids = cal.ids;
    const n = ids.length;
    const roundMats = [];
    for (let r = 0; r < cal.rounds; r++) {
      const mat = Array.from({ length: n }, () => Array(n).fill(NaN));
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const recI = cal.reports.get(`${r}:${ids[i]}`);
          const recJ = cal.reports.get(`${r}:${ids[j]}`);
          if (!recI || !recJ) continue;
          const a_ii = recI.get(ids[i]);
          const a_ij = recI.get(ids[j]);
          const a_ji = recJ.get(ids[i]);
          const a_jj = recJ.get(ids[j]);
          if (
            a_ii?.frame == null ||
            a_ij?.frame == null ||
            a_ji?.frame == null ||
            a_jj?.frame == null
          )
            continue;
          const t_ii = a_ii.frame / a_ii.sampleRate;
          const t_ij = a_ij.frame / a_ij.sampleRate;
          const t_ji = a_ji.frame / a_ji.sampleRate;
          const t_jj = a_jj.frame / a_jj.sampleRate;
          const d = beepBeepDistance(t_ii, t_ij, t_ji, t_jj);
          if (Number.isFinite(d) && d >= 0 && d <= 20) {
            mat[i][j] = d;
            mat[j][i] = d;
          }
        }
      }
      roundMats.push(mat);
    }

    const combined = combinePairwiseMatrices(roundMats);
    const fit = fitRelativeLayout2D(combined);
    const coords = {};
    if (fit.confidence === "high" && n >= 3) {
      ids.forEach((id, idx) => {
        const pt = fit.coords[idx];
        if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
          coords[id] = { x: pt[0], y: pt[1] };
        }
      });
      room.layout = {
        ...room.layout,
        mode: "measured",
        confidence: fit.confidence,
        residualCm: fit.medianResidualCm,
        coords,
      };
    } else {
      room.layout = {
        ...room.layout,
        mode: "schematic",
        confidence: fit.confidence,
        residualCm: fit.medianResidualCm,
        coords: {},
      };
    }
    publish(room);
    sendToHosts(room, {
      type: "acoustic_result",
      status: fit.confidence === "high" && n >= 3 ? "measured" : "low_confidence",
      deviceIds: ids,
      distances: combined,
      medianResidualCm: fit.medianResidualCm,
      maxResidualCm: fit.maxResidualCm,
      validPairs: fit.validPairs,
      confidence: fit.confidence,
    });
  };

  const runAcousticCalibration = (room, rounds = 2) => {
    const eligible = [...wss.clients].filter(
      (ws) =>
        ws.room === room &&
        ws.role === "phone" &&
        ws.readyState === WebSocket.OPEN &&
        room.devices.get(ws.deviceId)?.micReady,
    );
    if (eligible.length < 2) {
      sendToHosts(room, {
        type: "acoustic_result",
        status: "skipped",
        message:
          "Need at least 2 connected phones with optional microphone enabled.",
      });
      return;
    }
    if (room.calibration) clearTimeout(room.calibration.timer);
    const totalRounds = clamp(rounds, 1, 3);
    const ids = eligible.map((ws) => ws.deviceId);
    const calibrationId = Math.random().toString(36).slice(2, 10);
    room.calibration = {
      id: calibrationId,
      ids,
      rounds: totalRounds,
      reports: new Map(),
      timer: null,
    };

    const stepMs = 450;
    const schedule = [];
    let offsetMs = 200;
    for (let r = 0; r < totalRounds; r++) {
      for (let i = 0; i < eligible.length; i++) {
        schedule.push({
          round: r,
          slot: i,
          emitterId: ids[i],
          delayMs: offsetMs,
        });
        offsetMs += stepMs;
      }
    }
    for (const ws of eligible) {
      send(ws, {
        type: "acoustic_schedule",
        calibrationId,
        selfId: ws.deviceId,
        schedule,
      });
    }
    room.calibration.timer = setTimeout(
      () => finalizeCalibration(room),
      offsetMs + 1400,
    );
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
          const room = new Session(
            code,
            (event) => {
              for (const peer of wss.clients)
                if (peer.room === room && peer.role === "host") {
                  if (!send(peer, { type: "event", event }))
                    peer.pendingEvents = [...peer.pendingEvents, event].slice(
                      -40,
                    );
                }
            },
            (event) => {
              for (const peer of wss.clients)
                if (peer.room === room && peer.role === "host") {
                  send(peer, { type: "event_update", event });
                }
            },
          );
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
            if (!d) {
              const realCount = [...room.devices.values()].filter(
                (x) => !x.virtual,
              ).length;
              const name =
                m.name && String(m.name).trim()
                  ? m.name
                  : `Phone ${realCount + 1}`;
              d = room.join(name, m.position || null);
            }
            if (m.sensorState)
              room.setSensorStatus(d.id, { state: m.sensorState });
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
            send(ws, {
              type: "joined",
              token: d.secret,
              code: room.code,
              deviceId: d.id,
              name: d.name,
            });
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
        if (m.type === "sensor_status" && ws.role === "phone")
          room.setSensorStatus(ws.deviceId, m);
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
            d.placement = "manual";
          }
        }
        if (m.type === "pause" && ws.role === "phone") {
          const d = room.devices.get(ws.deviceId);
          if (d) {
            d.points = [];
            d.rate = 0;
            room.setSensorStatus(ws.deviceId, { state: "paused" });
          }
        }
        if (m.type === "acoustic_status" && ws.role === "phone") {
          const d = room.devices.get(ws.deviceId);
          if (d) d.micReady = Boolean(m.micReady);
        }
        if (m.type === "audio_onset" && ws.role === "phone") {
          const d = room.devices.get(ws.deviceId);
          if (
            d &&
            Number.isFinite(m.t) &&
            Number.isFinite(m.confidence)
          ) {
            d.lastAudioOnset = {
              t: m.t,
              confidence: clamp(m.confidence, 0, 1),
              peakDb: Number.isFinite(m.peakDb) ? m.peakDb : null,
            };
          }
        }
        if (m.type === "acoustic_report" && ws.role === "phone") {
          const cal = room.calibration;
          if (cal && m.calibrationId === cal.id && Array.isArray(m.arrivals)) {
            for (const entry of m.arrivals) {
              if (
                !entry ||
                !Number.isFinite(entry.round) ||
                !Number.isFinite(entry.frame) ||
                !Number.isFinite(entry.sampleRate) ||
                !entry.emitterId
              )
                continue;
              const key = `${entry.round}:${entry.emitterId}`;
              if (!cal.reports.has(key)) cal.reports.set(key, new Map());
              cal.reports.get(key).set(ws.deviceId, {
                frame: entry.frame,
                sampleRate: entry.sampleRate,
                snr: Number.isFinite(entry.snr) ? entry.snr : 0,
              });
            }
          }
        }
        if (ws.role === "host") {
          if (m.type === "settings")
            room.setSettings({
              profile: m.profile,
              threshold: m.threshold,
              windowMs: m.windowMs,
            });
          if (m.type === "layout_transform") {
            room.layout = {
              ...room.layout,
              rotationDeg: Number.isFinite(Number(m.rotationDeg))
                ? ((Number(m.rotationDeg) % 360) + 360) % 360
                : room.layout.rotationDeg,
              mirrorX:
                m.mirrorX !== undefined ? !!m.mirrorX : room.layout.mirrorX,
            };
          }
          if (m.type === "layout_reset") {
            room.layout = {
              mode: "schematic",
              rotationDeg: 0,
              mirrorX: false,
              confidence: null,
              residualCm: null,
              coords: {},
            };
          }
          if (m.type === "acoustic_calibrate") {
            runAcousticCalibration(room, m.rounds);
          }
          if (m.type === "simulation") {
            for (const peer of wss.clients)
              if (peer.room === room) peer.cursors.clear();
            room.simulation = !!m.enabled;
            room.tick = 0;
            room.seed = 42;
            room.detector.pending = [];
            room.detector.activeEvent = null;
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
              room.detector.activeEvent = null;
              impact(room);
            }
          }
          if (m.type === "impact" && room.simulation) {
            room.detector.pending = [];
            room.detector.last = -Infinity;
            room.detector.activeEvent = null;
            impact(room);
          }
        }
        if (
          [
            "simulation",
            "settings",
            "position",
            "pause",
            "sync",
            "sensor_status",
            "layout_transform",
            "layout_reset",
            "acoustic_status",
          ].includes(m.type)
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
      if (!active && now - (r.emptySince ??= now) > 60000) {
        if (r.calibration) clearTimeout(r.calibration.timer);
        rooms.delete(code);
      }
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
      for (const r of rooms.values()) {
        if (r.calibration) clearTimeout(r.calibration.timer);
      }
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
