import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createApp } from "../server.js";

function wsClient(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      const i = waiters.findIndex((w) => w.type === m.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else messages.push(m);
    });
    ws.next = (type) =>
      new Promise((resolveWait, rejectWait) => {
        const i = messages.findIndex((m) => m.type === type);
        if (i >= 0) return resolveWait(messages.splice(i, 1)[0]);
        const timer = setTimeout(() => rejectWait(Error("timeout " + type)), 3000);
        waiters.push({
          type,
          resolve: (m) => {
            clearTimeout(timer);
            resolveWait(m);
          },
        });
      });
    ws.sendJson = (m) => ws.send(JSON.stringify(m));
    ws.on("open", () => resolve(ws));
  });
}

test("server serves new browser/lib modules, offline /qr.svg, and runs placement-free performance flow over WS", async () => {
  const app = createApp();
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    for (const p of [
      "/",
      "/lib/signal.js",
      "/lib/qr.js",
      "/lib/acoustics.js",
      "/onboarding.js",
      "/synth.js",
      "/assist.js",
      "/midi.js",
      "/projector.js",
      "/acoustics-client.js",
      "/capture-worklet.js",
    ]) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200, `Expected 200 for ${p}`);
    }

    const qrRes = await fetch(
      `${base}/qr.svg?text=${encodeURIComponent("https://192.168.1.25:3000/?room=ABC123")}`,
    );
    assert.equal(qrRes.status, 200);
    assert.match(qrRes.headers.get("content-type"), /svg/);
    assert.match(await qrRes.text(), /^<svg[\s\S]*<\/svg>$/);

    const host = await wsClient(port);
    host.sendJson({ type: "create" });
    const created = await host.next("created");

    host.sendJson({
      type: "settings",
      profile: "performance",
      threshold: 5,
      windowMs: 110,
    });

    const p1 = await wsClient(port);
    const p2 = await wsClient(port);
    const p3 = await wsClient(port);

    p1.sendJson({ type: "join", code: created.code, sensorState: "place_flat" });
    p2.sendJson({ type: "join", code: created.code, sensorState: "place_flat" });
    p3.sendJson({ type: "join", code: created.code, sensorState: "place_flat" });
    await Promise.all([p1.next("joined"), p2.next("joined"), p3.next("joined")]);

    const room = app.rooms.get(created.code);
    const devs = [...room.devices.values()];
    assert.equal(devs.length, 3);
    assert.equal(devs[0].name, "Phone 1");
    assert.equal(devs[0].placement, "schematic");
    assert.equal(devs[0].x, null);
    assert.equal(devs[0].sensorState, "place_flat");

    const now = Date.now();
    // Baseline settle
    for (let i = 0; i < 6; i++) {
      const t = now - 200 + i * 20;
      p1.sendJson({ type: "samples", samples: [{ t, m: 9.81 }] });
      p2.sendJson({ type: "samples", samples: [{ t, m: 9.81 }] });
      p3.sendJson({ type: "samples", samples: [{ t, m: 9.81 }] });
    }
    await new Promise((r) => setTimeout(r, 30));

    // While sensorState is place_flat, bumps must NOT trigger shared event
    p1.sendJson({ type: "samples", samples: [{ t: now - 50, m: 12.0 }] });
    p2.sendJson({ type: "samples", samples: [{ t: now - 45, m: 12.0 }] });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(room.events.length, 0);

    // Move phones to ready, settle, then hit with p1 + p2 followed by late p3 within 110 ms
    p1.sendJson({ type: "sensor_status", state: "ready", tiltDeg: 1.2, stillStd: 0.01 });
    p2.sendJson({ type: "sensor_status", state: "ready", tiltDeg: 0.8, stillStd: 0.01 });
    p3.sendJson({ type: "sensor_status", state: "ready", tiltDeg: 1.5, stillStd: 0.01 });
    await new Promise((r) => setTimeout(r, 30));

    // Isolated bump on p1 alone stays silent
    p1.sendJson({ type: "samples", samples: [{ t: now - 30, m: 11.4 }] });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(room.events.length, 0);

    // Next shared knock at now + 180 (past 140 ms p1 refractory) across p1, p2, then late p3
    const hitT = now + 160;
    p1.sendJson({ type: "samples", samples: [{ t: hitT, m: 11.5 }] });
    p2.sendJson({ type: "samples", samples: [{ t: hitT + 10, m: 11.6 }] });
    const evtMsg = await host.next("event");
    assert.equal(evtMsg.event.origin, "live");
    assert.equal(evtMsg.event.profile, "performance");
    assert.equal(evtMsg.event.participants.length, 2);

    p3.sendJson({ type: "samples", samples: [{ t: hitT + 35, m: 12.2 }] });
    const updMsg = await host.next("event_update");
    assert.equal(updMsg.event.id, evtMsg.event.id);
    assert.equal(updMsg.event.participants.length, 3);
  } finally {
    await app.close();
  }
});
