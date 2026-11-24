import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../lib/session.js";
import {
  sendBounded,
  telemetry,
  advanceCursors,
  MAX_BUFFERED_BYTES,
} from "../lib/transport.js";
import { benchmark } from "../scripts/benchmark.js";
test("shared-event dispatch is synchronous with ingestion, before snapshot or telemetry timers", () => {
  const notifications = [],
    s = new Session("NOW", (e) => notifications.push(e));
  const a = s.join("A", {}),
    b = s.join("B", {}),
    t = Date.now();
  for (const d of [a, b]) s.ingest(d.id, [{ t: t - 20, m: 9.81 }], t);
  s.ingest(a.id, [{ t, m: 11 }], t);
  assert.equal(notifications.length, 0);
  s.ingest(b.id, [{ t, m: 11 }], t);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].participants.length, 2);
});
test("telemetry contains only new points; slow peers do not advance cursors or accumulate queues", () => {
  const s = new Session("SLOW"),
    d = s.join("A", {}),
    t = Date.now(),
    cursors = new Map(),
    writes = [];
  const ws = {
    readyState: 1,
    bufferedAmount: MAX_BUFFERED_BYTES + 1,
    send: (data) => writes.push(data),
  };
  s.ingest(d.id, [{ t, m: 9.81 }], t);
  let delta = telemetry(s, cursors);
  assert.equal(sendBounded(ws, delta), false);
  assert.equal(writes.length, 0);
  assert.equal(cursors.size, 0);
  ws.bufferedAmount = 0;
  assert.equal(sendBounded(ws, delta), true);
  advanceCursors(cursors, delta);
  assert.equal(telemetry(s, cursors).devices.length, 0);
  for (let i = 1; i <= 400; i++) s.ingest(d.id, [{ t: t + i, m: 9.81 }], t + i);
  delta = telemetry(s, cursors);
  assert.equal(delta.devices[0].points.length, 250);
  assert.equal(delta.devices[0].points.at(-1).seq, 401);
  assert.equal(delta.devices[0].secret, undefined);
});
test("local processing p95 stays within 10 ms for 24 sensors and four event subscribers", () => {
  const result = benchmark();
  assert.ok(result.eventDispatches > 0);
  assert.ok(result.p95Ms <= 10, JSON.stringify(result));
  console.log(
    `Pipeline benchmark: p95 ${result.p95Ms.toFixed(3)} ms; p99 ${result.p99Ms.toFixed(3)} ms; ${result.samples} samples`,
  );
});
