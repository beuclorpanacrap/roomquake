import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { estimateClock } from "../lib/signal.js";
import { renderQrSvg } from "../lib/qr.js";
import { createFlatStillTracker } from "../public/onboarding.js";
import { RoomQuakeSynth } from "../public/synth.js";
import { ASHEN_CATHEDRAL_CUE, PlayAssistSequencer } from "../public/assist.js";
import { parseMidiArrayBuffer, groupTrackToAssistSteps } from "../public/midi.js";
import { ProjectorStage } from "../public/projector.js";
import { AcousticExperimentClient } from "../public/acoustics-client.js";

function createHarness({ audioMock = false } = {}) {
  const elements = new Map(),
    listeners = new Map(),
    sent = [],
    frames = [],
    synthCalls = [];

  const paint = () => {
    const pending = frames.splice(0);
    for (const fn of pending) fn(performance.now());
  };

  const makeCtx = () => ({
    scale() {},
    setTransform() {},
    clearRect() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    stroke() {},
    fill() {},
    fillText() {},
    measureText: (s) => ({ width: String(s).length * 7 }),
    save() {},
    restore() {},
    setLineDash() {},
    roundRect() {},
    rect() {},
    createRadialGradient: () => ({ addColorStop() {} }),
  });

  const get = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        hidden: false,
        disabled: false,
        checked: false,
        value:
          id === "threshold"
            ? "5"
            : id === "windowMs"
              ? "180"
              : id === "profile"
                ? "lab"
                : id === "instrumentMode"
                  ? "free"
                  : id === "freeVoice"
                    ? "strings"
                    : "",
        textContent: "",
        innerHTML: "",
        style: {},
        dataset: {},
        clientWidth: 500,
        clientHeight: 240,
        setAttribute(k, v) {
          if (k === "data-state") this.dataset.state = v;
        },
        classList: { toggle() {}, add() {}, remove() {} },
        focus() {},
        getContext: makeCtx,
      });
    return elements.get(id);
  };

  let socket,
    requested = 0;
  class FakeSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      socket = this;
    }
    send(raw) {
      sent.push(JSON.parse(raw));
    }
  }

  class TrackedSynth extends RoomQuakeSynth {
    constructor(...args) {
      super(...args);
      this.trackLoaded = true;
    }
    unlock() {
      synthCalls.push({ type: "unlock" });
      return Promise.resolve(true);
    }
    getState() {
      return audioMock ? "running" : "locked";
    }
    playFreeHit(opts) {
      synthCalls.push({ type: "free", opts });
      return { voice: opts?.voice || "strings", releaseSec: 2.2 };
    }
    playAssistStep(step, intensity) {
      synthCalls.push({ type: "assist", step, intensity });
      return { layers: [step?.layer || "strings"] };
    }
    playPrankCue(opts) {
      synthCalls.push({ type: "prank", opts });
      return { cue: "local-track", durationSec: 2.4 };
    }
    pausePrankTrack() {
      synthCalls.push({ type: "pause" });
      return true;
    }
    hasPrankTrack() {
      return this.trackLoaded;
    }
  }

  const window = {
    isSecureContext: true,
    DeviceMotionEvent: {
      requestPermission: async () => {
        requested++;
        return "granted";
      },
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };

  const context = vm.createContext({
    estimateClock,
    renderQrSvg,
    createFlatStillTracker,
    RoomQuakeSynth: audioMock ? TrackedSynth : RoomQuakeSynth,
    ASHEN_CATHEDRAL_CUE,
    PlayAssistSequencer,
    parseMidiArrayBuffer,
    groupTrackToAssistSteps,
    ProjectorStage,
    AcousticExperimentClient,
    WebSocket: FakeSocket,
    document: {
      hidden: false,
      fullscreenElement: null,
      getElementById: get,
      querySelector: () => null,
      addEventListener() {},
      body: { classList: { add() {} } },
    },
    window,
    DeviceMotionEvent: window.DeviceMotionEvent,
    location: {
      protocol: "https:",
      host: "192.168.1.25:3000",
      hostname: "192.168.1.25",
      href: "https://192.168.1.25:3000",
      search: "",
    },
    URL,
    URLSearchParams,
    navigator: { clipboard: { writeText: async () => {} } },
    performance,
    requestAnimationFrame(fn) {
      frames.push(fn);
    },
    setInterval() {},
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    devicePixelRatio: 1,
  });

  const source = fs
    .readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\r?\n/gm, "");
  vm.runInContext(source, context);

  return {
    get,
    listeners,
    sent,
    paint,
    synthCalls,
    window,
    getSocket: () => socket,
    getRequested: () => requested,
  };
}

test("browser flow renders host state, enforces one-button permission gating, and joins placement-free", async () => {
  const h = createHarness();
  const socket = h.getSocket();
  socket.onopen();
  assert.equal(h.listeners.has("devicemotion"), false);

  h.get("create").onclick();
  assert.equal(h.sent.at(-1).type, "create");
  socket.onmessage({
    data: JSON.stringify({ type: "created", code: "ABC123", token: "host" }),
  });
  assert.equal(h.get("landing").hidden, true);
  assert.equal(h.get("dashboard").hidden, false);
  assert.match(h.get("labQrSvg").innerHTML, /<svg/);
  assert.match(h.get("projQrSvg").innerHTML, /<svg/);

  const now = Date.now();
  socket.onmessage({
    data: JSON.stringify({ type: "pong", sent: now - 10, server: now - 5 }),
  });
  socket.onmessage({
    data: JSON.stringify({
      type: "state",
      code: "ABC123",
      settings: { profile: "lab", threshold: 5, windowMs: 180 },
      layout: { mode: "schematic", rotationDeg: 0, mirrorX: false, coords: {} },
      simulation: true,
      events: [],
      devices: [
        {
          id: "virtual-0",
          name: "Virtual",
          virtual: true,
          connected: true,
          sensorState: "ready",
          x: 0,
          y: 0,
          lastSeen: now,
          points: [{ time: now, value: 0.3, noise: 0.02 }],
        },
      ],
    }),
  });
  h.paint();
  h.paint();
  assert.equal(h.get("count").textContent, "01");
  assert.match(h.get("devices").innerHTML, /Virtual/);
  assert.equal(h.get("simulate").textContent, "Stop simulation");
  assert.equal(h.getRequested(), 0);

  const event = {
    id: "event-1",
    origin: "live",
    time: now,
    serverEmittedAt: now,
    participants: [
      { id: "virtual-0", name: "Virtual", time: now, value: 1 },
      { id: "other", name: "Other", time: now + 5, value: 1 },
    ],
    peak: 1,
  };
  socket.onmessage({ data: JSON.stringify({ type: "event", event }) });
  assert.equal(h.get("eventCount").textContent, "00");
  h.paint();
  h.paint();
  assert.equal(h.get("eventCount").textContent, "01");
  socket.onmessage({ data: JSON.stringify({ type: "event", event }) });
  h.paint();
  h.paint();
  assert.equal(h.get("eventCount").textContent, "01");

  h.get("mode").value = "eco";
  h.get("mode").onchange();
  assert.equal(h.sent.at(-1).mode, "eco");

  // Phone one-button Join & Enable Motion: requests permission on tap, joins without position,
  // and starts streaming only after BOTH permission and room join succeed.
  h.get("code").value = "ABC123";
  await h.get("join").onclick();
  assert.equal(h.getRequested(), 1);
  const joinMsg = h.sent.at(-1);
  assert.equal(joinMsg.type, "join");
  assert.equal(joinMsg.position, undefined);
  assert.equal(h.listeners.has("devicemotion"), false);

  socket.onmessage({
    data: JSON.stringify({ type: "joined", code: "ABC123", token: "phone" }),
  });
  assert.equal(h.get("phone").hidden, false);
  assert.equal(h.listeners.has("devicemotion"), true);

  h.listeners.get("devicemotion")({
    accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 },
  });
  assert.equal(h.sent.at(-1).type, "samples");
  assert.equal(h.sent.at(-1).samples.length, 1);

  h.get("stop").onclick();
  assert.equal(h.listeners.has("devicemotion"), false);

  await h.get("enable").onclick();
  assert.equal(h.getRequested(), 2);
  assert.equal(h.listeners.has("devicemotion"), true);
  h.get("stop").onclick();

  // Insecure context blocks motion
  h.window.isSecureContext = false;
  await h.get("enable").onclick();
  assert.match(h.get("notice").textContent, /HTTPS/);
  assert.equal(h.listeners.has("devicemotion"), false);

  // Denied permission blocks motion
  h.window.isSecureContext = true;
  h.window.DeviceMotionEvent.requestPermission = async () => "denied";
  await h.get("enable").onclick();
  assert.match(h.get("notice").textContent, /denied/);
  assert.equal(h.listeners.has("devicemotion"), false);
});

test("host plays the shared-impact cue once and suppresses stale, simulated, duplicate, and update audio", () => {
  const h = createHarness({ audioMock: true });
  const socket = h.getSocket();
  socket.onopen();
  h.get("create").onclick();
  socket.onmessage({
    data: JSON.stringify({ type: "created", code: "XYZ789", token: "host" }),
  });

  const now = Date.now();
  socket.onmessage({
    data: JSON.stringify({ type: "pong", sent: now - 8, server: now - 4 }),
  });
  socket.onmessage({
    data: JSON.stringify({
      type: "state",
      code: "XYZ789",
      settings: { profile: "lab", threshold: 5, windowMs: 180 },
      layout: { mode: "schematic", rotationDeg: 0, mirrorX: false, coords: {} },
      simulation: false,
      events: [
        {
          id: "hydrated-old",
          origin: "live",
          time: now - 200,
          serverEmittedAt: now - 200,
          participants: [
            { id: "p1", name: "Phone 1", time: now - 200, value: 1.5 },
            { id: "p2", name: "Phone 2", time: now - 190, value: 1.3 },
          ],
          peak: 1.5,
        },
      ],
      devices: [
        { id: "p1", name: "Phone 1", connected: true, sensorState: "ready", points: [] },
        { id: "p2", name: "Phone 2", connected: true, sensorState: "ready", points: [] },
        { id: "p3", name: "Phone 3", connected: true, sensorState: "ready", points: [] },
      ],
    }),
  });

  h.synthCalls.length = 0;

  // 1. Replayed hydrated event must NOT sound
  socket.onmessage({
    data: JSON.stringify({
      type: "event",
      event: {
        id: "hydrated-old",
        origin: "live",
        time: now - 200,
        serverEmittedAt: now - 200,
        participants: [
          { id: "p1", name: "Phone 1", time: now - 200, value: 1.5 },
          { id: "p2", name: "Phone 2", time: now - 190, value: 1.3 },
        ],
        peak: 1.5,
      },
    }),
  });
  assert.equal(h.synthCalls.length, 0);

  // 2. Stale event (> 1500 ms) must NOT sound
  socket.onmessage({
    data: JSON.stringify({
      type: "event",
      event: {
        id: "stale-evt",
        origin: "live",
        time: now - 4000,
        serverEmittedAt: now - 4000,
        participants: [
          { id: "p1", name: "Phone 1", time: now - 4000, value: 1.4 },
          { id: "p2", name: "Phone 2", time: now - 3990, value: 1.2 },
        ],
        peak: 1.4,
      },
    }),
  });
  assert.equal(h.synthCalls.length, 0);

  // 3. Simulated event must NOT sound when auditionSim is false
  socket.onmessage({
    data: JSON.stringify({
      type: "event",
      event: {
        id: "sim-evt",
        origin: "simulated",
        time: now,
        serverEmittedAt: now,
        participants: [
          { id: "v0", name: "V0", time: now, value: 1.4 },
          { id: "v1", name: "V1", time: now + 10, value: 1.2 },
        ],
        peak: 1.4,
      },
    }),
  });
  assert.equal(h.synthCalls.length, 0);

  // 4. Fresh live event plays the surprise cue ONCE
  socket.onmessage({
    data: JSON.stringify({
      type: "event",
      event: {
        id: "live-1",
        origin: "live",
        time: now,
        serverEmittedAt: now,
        intensity: 0.72,
        participants: [
          { id: "p1", name: "Phone 1", time: now, value: 1.8 },
          { id: "p2", name: "Phone 2", time: now + 8, value: 1.5 },
        ],
        peak: 1.8,
      },
    }),
  });
  assert.equal(h.synthCalls.length, 1);
  assert.equal(h.synthCalls[0].type, "prank");
  assert.equal(h.synthCalls[0].opts.intensity, 0.72);

  // 5. Duplicate live-1 or late event_update must NOT play sound or advance Assist
  socket.onmessage({
    data: JSON.stringify({
      type: "event",
      event: {
        id: "live-1",
        origin: "live",
        time: now,
        serverEmittedAt: now,
        participants: [
          { id: "p1", name: "Phone 1", time: now, value: 1.8 },
          { id: "p2", name: "Phone 2", time: now + 8, value: 1.5 },
        ],
        peak: 1.8,
      },
    }),
  });
  socket.onmessage({
    data: JSON.stringify({
      type: "event_update",
      event: {
        id: "live-1",
        origin: "live",
        time: now,
        serverEmittedAt: now,
        participants: [
          { id: "p1", name: "Phone 1", time: now, value: 1.8 },
          { id: "p2", name: "Phone 2", time: now + 8, value: 1.5 },
          { id: "p3", name: "Phone 3", time: now + 22, value: 2.1 },
        ],
        peak: 2.1,
      },
    }),
  });
  assert.equal(h.synthCalls.length, 1);

  // 6. Opening Projector switches lab profile -> performance automatically
  h.get("openProjector").onclick();
  assert.equal(h.get("projector").hidden, false);
  const settingsSent = h.sent.find((m) => m.type === "settings");
  assert.equal(settingsSent.profile, "performance");
  assert.equal(settingsSent.windowMs, 110);
});
