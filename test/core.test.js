import test from "node:test";
import assert from "node:assert/strict";
import { Signal, Events, estimateClock } from "../lib/signal.js";
import { Session } from "../lib/session.js";
import { createApp } from "../server.js";
import { WebSocket } from "ws";
test("detrend rejects gravity and slow drift, impact triggers, refractory period suppresses duplicates", () => {
  const s = new Signal();
  for (let i = 0; i < 200; i++)
    assert.equal(s.push(9.81 + i * 0.0001, i * 20).trigger, false);
  assert.equal(s.push(11.2, 4000).trigger, true);
  assert.equal(s.push(11.2, 4020).trigger, false);
  assert.equal(s.push(9.81, 4000), null);
  assert.equal(s.push(NaN, 5000), null);
});
test("shared events require distinct sensors inside the time window", () => {
  const e = new Events(),
    t = (id, time) => ({ id, time, value: 1 });
  assert.equal(e.push(t("a", 1000)), null);
  assert.equal(e.push(t("a", 1050)), null);
  assert.equal(e.push(t("b", 1400)), null);
  const event = e.push(t("a", 1450));
  assert.equal(event.participants.length, 2);
  assert.equal(event.time, 1400);
  assert.equal(e.push(t("b", 1500)), null);
});
test("clock estimation uses lowest latency samples and reports uncertainty", () => {
  const samples = [10, 12, 14, 16, 18, 1000].map((rtt, i) => ({
    sent: i * 2000,
    received: i * 2000 + rtt,
    server: i * 2000 + rtt / 2 + 120 + (i === 5 ? 300 : 0),
  }));
  const result = estimateClock(samples);
  assert.equal(result.offset, 120);
  assert.equal(result.rtt, 10);
  assert.equal(result.uncertainty, 9);
  assert.equal(estimateClock([{ sent: NaN }]), null);
});
test("session validates input, bounds buffers and does not expose sensor credentials", () => {
  const s = new Session("ABC123"),
    d = s.join("<phone>", { x: -5, y: 100 });
  assert.equal(d.x, 0);
  assert.equal(d.y, 4);
  const now = Date.now();
  for (let i = 0; i < 400; i++)
    s.ingest(d.id, [{ t: now - 4000 + i * 10, m: 9.81 }], now);
  assert.equal(d.points.length, 250);
  assert.equal(s.snapshot().devices[0].points.length, 160);
  assert.equal(s.snapshot().devices[0].secret, undefined);
  const before = d.samples;
  s.ingest(
    d.id,
    [
      { t: now, m: Infinity },
      { t: now + 99999, m: 10 },
    ],
    now,
  );
  assert.equal(d.samples, before);
  assert.equal(s.ingest(d.id, Array(101).fill({})), false);
});
function client(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`),
      messages = [],
      waiters = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      const i = waiters.findIndex((w) => w.type === m.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else messages.push(m);
    });
    ws.next = (type) =>
      new Promise((resolve, reject) => {
        const i = messages.findIndex((m) => m.type === type);
        if (i >= 0) return resolve(messages.splice(i, 1)[0]);
        const timer = setTimeout(() => reject(Error("timeout " + type)), 3000);
        waiters.push({
          type,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    ws.sendJson = (m) => ws.send(JSON.stringify(m));
    ws.on("open", () => resolve(ws));
  });
}
test("server room authentication, sync, streaming, simulation, disconnect and reconnect", async () => {
  const app = createApp();
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  try {
    const host = await client(port);
    host.sendJson({ type: "create" });
    const room = await host.next("created");
    const bad = await client(port);
    bad.sendJson({
      type: "join",
      role: "host",
      code: room.code,
      token: "wrong",
    });
    assert.match((await bad.next("error")).message, /credential/);
    bad.close();
    const phone = await client(port);
    phone.sendJson({ type: "join", code: room.code, name: "Test phone" });
    const joined = await phone.next("joined");
    phone.sendJson({ type: "ping", sent: 100 });
    assert.equal((await phone.next("pong")).sent, 100);
    phone.sendJson({ type: "sync", rtt: 10, uncertainty: 5 });
    phone.sendJson({ type: "samples", samples: [{ t: Date.now(), m: 9.81 }] });
    await new Promise((r) => setTimeout(r, 40));
    const session = app.rooms.get(room.code);
    assert.equal([...session.devices.values()][0].samples, 1);
    phone.sendJson({ type: "settings", threshold: 12, windowMs: 500 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(session.settings.threshold, 5);
    host.sendJson({ type: "simulation", enabled: true });
    const firstEvent = await host.next("event");
    assert.equal(firstEvent.event.participants.length, 2);
    host.sendJson({ type: "impact" });
    const immediateEvent = await host.next("event");
    assert.notEqual(immediateEvent.event.id, firstEvent.event.id);
    assert.equal(session.devices.size, 5);
    assert.ok(session.events.length > 0);
    phone.close();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal([...session.devices.values()][0].connected, false);
    assert.equal([...session.devices.values()][0].points.length, 0);
    const resumed = await client(port);
    resumed.sendJson({ type: "join", code: room.code, token: joined.token });
    assert.equal((await resumed.next("joined")).token, joined.token);
    assert.equal(session.devices.size, 5);
    host.sendJson({ type: "simulation", enabled: false });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(session.devices.size, 1);
  } finally {
    await app.close();
  }
});
