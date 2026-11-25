import test from "node:test";
import assert from "node:assert/strict";
import { PROFILES, Signal, Events } from "../lib/signal.js";
import { Session } from "../lib/session.js";

function warmSession(profile = "performance", sensorCount = 2, startTime = 1_000_000) {
  const emitted = [];
  const updated = [];
  const session = new Session(
    "PERF01",
    (e) => emitted.push(e),
    (e) => updated.push(e),
  );
  session.setSettings({ profile });
  const devices = Array.from({ length: sensorCount }, (_, i) =>
    session.join(`Phone ${i + 1}`, { x: i, y: 1 }),
  );
  // Warm baseline at 50 Hz for 1000 ms so EWMA mean/noise are settled.
  let t = startTime;
  for (let i = 0; i < 50; i++) {
    t += 20;
    for (const d of devices) {
      session.ingest(d.id, [{ t, m: 9.81 }], t);
    }
  }
  return { session, devices, emitted, updated, time: t };
}

test("performance profile emits all 4/4 beats at 120 BPM (500 ms) and 180 BPM (333 ms)", () => {
  for (const [bpm, intervalMs] of [
    [120, 500],
    [180, 333],
  ]) {
    const { session, devices, emitted, time } = warmSession("performance");
    const beatTimes = [0, 1, 2, 3].map((k) => time + 100 + k * intervalMs);
    const beatSet = new Set(beatTimes);

    // Stream continuous 50 Hz baseline with sharp hits on beat timestamps.
    for (let t = time + 20; t <= beatTimes.at(-1) + 120; t += 20) {
      const closestBeat = beatTimes.find((bt) => Math.abs(t - bt) < 20);
      const isHit = closestBeat !== undefined && t >= closestBeat && t < closestBeat + 20;
      const m = isHit ? 11.4 : 9.81;
      for (let i = 0; i < devices.length; i++) {
        session.ingest(devices[i].id, [{ t: t + i * 5, m }], t + i * 5);
      }
    }

    // Ensure exact timestamps if intervalMs wasn't a multiple of 20 (e.g. 333 ms).
    assert.equal(
      emitted.length,
      4,
      `Expected 4/4 events at ${bpm} BPM (${intervalMs} ms), got ${emitted.length}`,
    );
    assert.equal(beatSet.size, 4);
    assert.deepEqual(
      emitted.map((e) => e.seq),
      [1, 2, 3, 4],
    );
    for (const e of emitted) {
      assert.equal(e.profile, "performance");
      assert.equal(e.origin, "live");
      assert.ok(e.intensity >= 0.05 && e.intensity <= 1);
    }
  }
});

test("exact 333 ms beat timestamps (non-20ms aligned) emit all 4/4 beats in performance profile", () => {
  const { session, devices, emitted, time } = warmSession("performance");
  const beatTimes = [0, 1, 2, 3].map((k) => time + 100 + k * 333);
  let nextBeatIdx = 0;
  let t = time;
  while (t <= beatTimes.at(-1) + 100) {
    const nextBeat = beatTimes[nextBeatIdx];
    if (nextBeat !== undefined && t + 20 >= nextBeat) {
      t = nextBeat;
      nextBeatIdx++;
      for (let i = 0; i < devices.length; i++) {
        session.ingest(devices[i].id, [{ t: t + i * 6, m: 11.5 }], t + i * 6);
      }
    } else {
      t += 20;
      for (let i = 0; i < devices.length; i++) {
        session.ingest(devices[i].id, [{ t: t + i * 6, m: 9.81 }], t + i * 6);
      }
    }
  }
  assert.equal(emitted.length, 4);
});

test("decaying tabletop ringing (exponential and sinusoid, including below 0.45 * peak) does not double-trigger", () => {
  // 1) Monotonic decaying exponential ringing after strong knock
  {
    const s = new Signal();
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += 20;
      assert.equal(s.push(9.81, t, 5, "performance").trigger, false);
    }
    const knockAt = t + 20;
    const first = s.push(9.81 + 4.0, knockAt, 5, "performance");
    assert.equal(first.trigger, true);

    const extraTriggers = [];
    for (let dt = 20; dt <= 800; dt += 20) {
      // Decays cleanly through 0.45 * peak and down toward baseline.
      const ring = 4.0 * Math.exp(-dt / 140);
      const res = s.push(9.81 + ring, knockAt + dt, 5, "performance");
      if (res.trigger) extraTriggers.push({ dt, value: res.value });
    }
    assert.deepEqual(extraTriggers, []);
  }

  // 2) Decaying sinusoidal ringing crossing zero and swinging below 0.45 * peak
  {
    const s = new Signal();
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += 20;
      s.push(9.81, t, 5, "performance");
    }
    const knockAt = t + 20;
    assert.equal(s.push(9.81 + 3.8, knockAt, 5, "performance").trigger, true);

    const extraTriggers = [];
    for (let dt = 10; dt <= 900; dt += 10) {
      const ring =
        3.8 * Math.exp(-dt / 150) * Math.cos((2 * Math.PI * 18 * dt) / 1000);
      const res = s.push(9.81 + ring, knockAt + dt, 5, "performance");
      if (res.trigger) extraTriggers.push({ dt, value: res.value });
    }
    assert.deepEqual(extraTriggers, []);
  }

  // 3) Sharp new strike rising clearly above decaying ringing DOES trigger
  {
    const s = new Signal();
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += 20;
      s.push(9.81, t, 5, "performance");
    }
    const knockAt = t + 20;
    assert.equal(s.push(9.81 + 3.0, knockAt, 5, "performance").trigger, true);
    for (let dt = 20; dt <= 160; dt += 20) {
      const ring = 3.0 * Math.exp(-dt / 140);
      assert.equal(
        s.push(9.81 + ring, knockAt + dt, 5, "performance").trigger,
        false,
      );
    }
    // At dt = 180 ms (> 140 ms refractory), a sharp new strike jumps > 1.35x envelope
    const second = s.push(9.81 + 3.2, knockAt + 180, 5, "performance");
    assert.equal(second.trigger, true);
  }
});

test("isolated single-phone bump emits 0 events", () => {
  const { session, devices, emitted, updated, time } = warmSession("performance", 3);
  session.ingest(devices[0].id, [{ t: time + 40, m: 13.0 }], time + 40);
  for (let dt = 60; dt <= 400; dt += 20) {
    for (const d of devices) {
      session.ingest(d.id, [{ t: time + dt, m: 9.81 }], time + dt);
    }
  }
  assert.equal(emitted.length, 0);
  assert.equal(updated.length, 0);
  assert.equal(session.events.length, 0);
});

test("3rd and 4th sensors arriving within windowMs trigger onEventUpdate instead of duplicate onEvent", () => {
  const { session, devices, emitted, updated, time } = warmSession("performance", 4);
  const t0 = time + 40;
  session.ingest(devices[0].id, [{ t: t0, m: 11.4 }], t0);
  assert.equal(emitted.length, 0);

  session.ingest(devices[1].id, [{ t: t0 + 12, m: 11.6 }], t0 + 12);
  assert.equal(emitted.length, 1);
  assert.equal(updated.length, 0);
  assert.equal(emitted[0].participants.length, 2);
  const initialPeak = emitted[0].peak;

  session.ingest(
    devices[2].id,
    [
      { t: t0, m: 9.81 },
      { t: t0 + 20, m: 9.81 },
      { t: t0 + 45, m: 12.1 },
    ],
    t0 + 45,
  );
  assert.equal(emitted.length, 1);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, emitted[0].id);
  assert.equal(updated[0].participants.length, 3);
  assert.equal(updated[0].participants[2].delayMs, 45);

  session.ingest(
    devices[3].id,
    [
      { t: t0, m: 9.81 },
      { t: t0 + 20, m: 9.81 },
      { t: t0 + 40, m: 9.81 },
      { t: t0 + 60, m: 9.81 },
      { t: t0 + 80, m: 12.5 },
    ],
    t0 + 80,
  );
  assert.equal(emitted.length, 1);
  assert.equal(updated.length, 2);
  assert.equal(session.events.length, 1);
  assert.equal(session.events[0].participants.length, 4);
  assert.equal(session.events[0].participants[3].delayMs, 80);
  assert.ok(session.events[0].peak > initialPeak);
  assert.ok(session.events[0].peak > 2.0);
});

test("Events.push returns { update: true } for late sensor and clears activeEvent when last = -Infinity", () => {
  const detector = new Events();
  assert.equal(
    detector.push({ id: "a", time: 1000, value: 1.0 }, 110, "performance"),
    null,
  );
  const first = detector.push(
    { id: "b", time: 1015, value: 1.2 },
    110,
    "performance",
  );
  assert.equal(first.participants.length, 2);
  assert.equal(first.participants[0].delayMs, 0);
  assert.equal(first.participants[1].delayMs, 15);

  const upd = detector.push(
    { id: "c", time: 1050, value: 2.0 },
    110,
    "performance",
  );
  assert.equal(upd.update, true);
  assert.equal(upd.event.participants.length, 3);
  assert.equal(upd.event.peak, 2.0);

  // Simulation immediate impact resets detector.last = -Infinity
  detector.pending = [];
  detector.last = -Infinity;
  assert.equal(
    detector.push({ id: "v0", time: 1060, value: 1.5 }, 110, "performance"),
    null,
  );
  const sim = detector.push(
    { id: "v1", time: 1065, value: 1.5 },
    110,
    "performance",
  );
  assert.equal(sim.update, undefined);
  assert.equal(sim.participants.length, 2);
});

test("lab profile continues to suppress 500 ms repeats", () => {
  const { session, devices, emitted, time } = warmSession("lab", 2);
  const beatTimes = [0, 1, 2, 3].map((k) => time + 100 + k * 500);
  for (let t = time + 20; t <= beatTimes.at(-1) + 120; t += 20) {
    const m = beatTimes.includes(t) ? 11.4 : 9.81;
    for (const d of devices) {
      session.ingest(d.id, [{ t, m }], t);
    }
  }
  // 500 ms interval is inside lab's 650/700 ms refractory, so beats 2 and 4 are suppressed.
  assert.equal(emitted.length, 2);
});

test("sensorState !== 'ready' suppresses triggers and clears pending triggers", () => {
  const { session, devices, emitted, time } = warmSession("performance", 2);

  for (const blockedState of ["place_flat", "calibrating", "moved", "paused"]) {
    session.setSensorStatus(devices[0].id, {
      state: blockedState,
      tiltDeg: 25,
      stillStd: 0.9,
    });
    const t = time + 100;
    session.ingest(devices[0].id, [{ t, m: 12.0 }], t);
    session.ingest(devices[1].id, [{ t: t + 5, m: 12.0 }], t + 5);
    assert.equal(emitted.length, 0);
  }

  // Returning to ready allows triggers again, and moving drops pending triggers.
  session.setSensorStatus(devices[0].id, { state: "ready", tiltDeg: 0.5, stillStd: 0.01 });
  const t1 = time + 500;
  session.ingest(devices[0].id, [{ t: t1, m: 12.0 }], t1);
  assert.equal(session.detector.pending.length, 1);
  session.setSensorStatus(devices[0].id, { state: "moved" });
  assert.equal(session.detector.pending.length, 0);
  session.ingest(devices[1].id, [{ t: t1 + 10, m: 12.0 }], t1 + 10);
  assert.equal(emitted.length, 0);
});

test("Session settings, placement metadata, origin classification, and snapshot contract", () => {
  const emitted = [];
  const s = new Session("META", (e) => emitted.push(e));
  assert.equal(s.settings.profile, "lab");
  assert.equal(s.settings.windowMs, PROFILES.lab.defaultWindowMs);

  s.setSettings({ profile: "performance", threshold: 100, windowMs: 10 });
  assert.deepEqual(s.settings, {
    profile: "performance",
    threshold: 12,
    windowMs: 50,
  });
  s.setSettings({ profile: "invalid", threshold: 0, windowMs: 999 });
  assert.deepEqual(s.settings, {
    profile: "performance",
    threshold: 2,
    windowMs: 500,
  });
  s.setSettings({ profile: "lab" });
  assert.equal(s.settings.windowMs, PROFILES.lab.defaultWindowMs);

  const live = s.join("Live");
  const manual = s.join("Manual", { x: 2, y: 3 });
  const virt = s.join("Sim", { x: 1, y: 1 }, "virtual-0");
  virt.virtual = true;

  assert.equal(live.placement, "schematic");
  assert.equal(live.x, null);
  assert.equal(live.y, null);
  assert.equal(manual.placement, "manual");
  assert.equal(manual.x, 2);
  assert.equal(manual.y, 3);
  assert.equal(s.setSensorStatus(live.id, { state: "unknown" }), null);

  const now = 5_000_000;
  s.ingest(live.id, [{ t: now - 20, m: 9.81 }], now);
  s.ingest(virt.id, [{ t: now - 20, m: 9.81 }], now);
  s.ingest(live.id, [{ t: now, m: 12.0 }], now);
  s.ingest(virt.id, [{ t: now + 5, m: 12.0 }], now + 5);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].origin, "mixed");

  const snap = s.snapshot({ points: false });
  assert.equal(snap.layout.mode, "schematic");
  assert.equal(snap.devices[0].placement, "schematic");
  assert.equal(snap.devices[0].sensorState, "ready");
  assert.equal(snap.devices[0].secret, undefined);
});
