import { createApp } from "../server.js";
import { WebSocket } from "ws";
import assert from "node:assert/strict";
const app = createApp();
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const url = `ws://127.0.0.1:${app.server.address().port}`;
const open = () =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
  });
const next = (ws, type) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Timed out: " + type)), 3000);
    const listener = (raw) => {
      const data = JSON.parse(raw);
      if (data.type === type) {
        clearTimeout(timer);
        ws.off("message", listener);
        resolve(data);
      }
    };
    ws.on("message", listener);
  });
const send = (ws, m) => ws.send(JSON.stringify(m));
try {
  const host = await open();
  const created = next(host, "created");
  send(host, { type: "create" });
  const room = await created;
  const phones = [];
  for (let i = 0; i < 24; i++) {
    const ws = await open();
    const joined = next(ws, "joined");
    send(ws, { type: "join", code: room.code, name: `Stress ${i}` });
    await joined;
    phones.push(ws);
  }
  let telemetry = 0,
    fullStates = 0,
    events = 0,
    bytes = 0,
    maxPayload = 0;
  const errors = [];
  host.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "telemetry") telemetry++;
    if (m.type === "state") fullStates++;
    if (m.type === "event") events++;
    if (m.type === "error") errors.push(m.message);
    bytes += raw.length;
    maxPayload = Math.max(maxPayload, raw.length);
  });
  for (const phone of phones)
    phone.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "error") errors.push(m.message);
    });
  const started = performance.now();
  for (let tick = 0; tick < 200; tick++) {
    const t = Date.now();
    for (const phone of phones)
      send(phone, {
        type: "samples",
        samples: [{ t, m: 9.81 + (tick % 80 === 40 ? 1.3 : 0) }],
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const session = app.rooms.get(room.code),
    result = {
      durationMs: performance.now() - started,
      sensors: 24,
      samples: [...session.devices.values()].reduce((n, d) => n + d.samples, 0),
      telemetryPackets: telemetry,
      fullStatePackets: fullStates,
      events,
      receivedBytes: bytes,
      maxPayloadBytes: maxPayload,
      processingP95Ms: session.snapshot().processingP95,
      errors,
    };
  assert.equal(result.samples, 4800);
  assert.equal(errors.length, 0);
  assert.ok(maxPayload < 65536);
  assert.ok(events >= 2);
  assert.ok(telemetry < 220);
  assert.ok(fullStates < 8);
  assert.ok([...session.devices.values()].every((d) => d.points.length <= 250));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close();
}
