import test from "node:test";
import assert from "node:assert/strict";
import { createFlatStillTracker } from "../public/onboarding.js";

test("tilted phone stays in place_flat", () => {
  const tracker = createFlatStillTracker();
  let last;
  for (let i = 0; i < 60; i++) {
    // ~45 degree tilt: cosTheta = 1/sqrt(2) ≈ 0.707 < 0.94
    last = tracker.push({ x: 6.9, y: 0, z: 6.9, t: i * 20 });
    assert.equal(last.state, "place_flat");
    assert.equal(last.progress, 0);
  }
  assert.ok(last.tiltDeg > 40);
});

test("flat and still transitions place_flat -> calibrating -> ready", () => {
  const tracker = createFlatStillTracker();
  const seenStates = new Set();
  let becameCalibrating = false;
  let becameReady = false;

  for (let i = 0; i < 80; i++) {
    const jitter = (i % 2 === 0 ? 1 : -1) * 0.01;
    const res = tracker.push({ x: 0.05, y: 0.05, z: 9.81 + jitter, t: i * 20 });
    seenStates.add(res.state);
    if (res.changed && res.state === "calibrating") becameCalibrating = true;
    if (res.changed && res.state === "ready") becameReady = true;
    if (res.state === "calibrating") {
      assert.ok(res.progress >= 0 && res.progress < 1);
    }
    if (res.state === "ready") {
      assert.equal(res.progress, 1);
    }
  }

  assert.equal(becameCalibrating, true);
  assert.equal(becameReady, true);
  assert.ok(seenStates.has("place_flat"));
  assert.ok(seenStates.has("calibrating"));
  assert.ok(seenStates.has("ready"));
});

test("brief table impulse (< 250 ms) while ready keeps state ready", () => {
  const tracker = createFlatStillTracker();
  let t = 0;
  for (let i = 0; i < 80; i++) {
    t += 20;
    tracker.push({ x: 0, y: 0, z: 9.81, t });
  }
  assert.equal(tracker.push({ x: 0, y: 0, z: 9.81, t: (t += 20) }).state, "ready");

  // 120 ms sharp tap impulse (including lateral acceleration dipping cosTheta briefly)
  const impulse = [
    { x: 5.0, y: 3.0, z: 14.5 },
    { x: -4.0, y: 2.0, z: 6.2 },
    { x: 3.5, y: -2.0, z: 12.8 },
    { x: -1.5, y: 1.0, z: 8.1 },
    { x: 0.8, y: 0.2, z: 10.6 },
    { x: 0.1, y: 0.0, z: 9.9 },
  ];
  for (const s of impulse) {
    t += 20;
    const res = tracker.push({ ...s, t });
    assert.equal(res.state, "ready");
  }

  // Follow with 1.5 s of stillness: must remain ready the entire time.
  for (let i = 0; i < 75; i++) {
    t += 20;
    const res = tracker.push({ x: 0, y: 0, z: 9.81, t });
    assert.equal(res.state, "ready");
    assert.equal(res.changed, false);
  }
});

test("sustained pickup/tilt transitions to moved and placing flat & still recovers to ready", () => {
  const tracker = createFlatStillTracker();
  let t = 0;
  for (let i = 0; i < 80; i++) {
    t += 20;
    tracker.push({ x: 0, y: 0, z: 9.81, t });
  }
  assert.equal(tracker.push({ x: 0, y: 0, z: 9.81, t: (t += 20) }).state, "ready");

  // Sustained tilt (> 350 ms) drops to moved
  let movedAt = null;
  for (let i = 0; i < 30; i++) {
    t += 20;
    const res = tracker.push({ x: 7.0, y: 0, z: 6.8, t });
    if (res.state === "moved" && movedAt === null) movedAt = i;
  }
  assert.notEqual(movedAt, null);

  // Place flat and still again -> recovers through calibrating -> ready
  let sawCalibrating = false;
  let sawReady = false;
  for (let i = 0; i < 150; i++) {
    t += 20;
    const res = tracker.push({ x: 0, y: 0, z: 9.81, t });
    if (res.state === "calibrating") sawCalibrating = true;
    if (res.state === "ready") {
      sawReady = true;
      break;
    }
  }
  assert.equal(sawCalibrating, true);
  assert.equal(sawReady, true);
});

test("sustained high variance (> 500 ms) transitions to moved and reset() clears state", () => {
  const tracker = createFlatStillTracker();
  let t = 0;
  for (let i = 0; i < 80; i++) {
    t += 20;
    tracker.push({ x: 0, y: 0, z: 9.81, t });
  }
  assert.equal(tracker.push({ x: 0, y: 0, z: 9.81, t: (t += 20) }).state, "ready");

  let becameMoved = false;
  for (let i = 0; i < 40; i++) {
    t += 20;
    const z = 9.81 + (i % 2 === 0 ? 2.5 : -2.5);
    const res = tracker.push({ x: 0, y: 0, z, t });
    if (res.state === "moved") becameMoved = true;
  }
  assert.equal(becameMoved, true);

  tracker.reset();
  const afterReset = tracker.push({ x: 0, y: 0, z: 9.81, t: 0 });
  assert.equal(afterReset.state, "place_flat");
  assert.equal(afterReset.stillStd, Infinity);
  assert.equal(afterReset.progress, 0);
});
