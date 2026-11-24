import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { estimateClock } from "../lib/signal.js";

test("browser flow renders host state and requires explicit permission before registering motion", async () => {
  const elements = new Map(),
    listeners = new Map(),
    sent = [],
    frames = [];
  const paint = () => {
    const pending = frames.splice(0);
    for (const fn of pending) fn(performance.now());
  };
  const get = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        hidden: false,
        value: id === "threshold" ? "5" : id === "windowMs" ? "180" : "",
        textContent: "",
        innerHTML: "",
        style: {},
        clientWidth: 500,
        getContext: () => ({
          scale() {},
          setTransform() {},
          clearRect() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
        }),
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
    WebSocket: FakeSocket,
    document: { getElementById: get, addEventListener() {} },
    window,
    DeviceMotionEvent: window.DeviceMotionEvent,
    location: {
      protocol: "http:",
      host: "localhost:3000",
      hostname: "localhost",
      href: "http://localhost:3000",
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
    .replace(/^import[^\n]+\n/, "");
  vm.runInContext(source, context);
  socket.onopen();
  assert.equal(listeners.has("devicemotion"), false);
  get("create").onclick();
  assert.equal(sent.at(-1).type, "create");
  socket.onmessage({
    data: JSON.stringify({ type: "created", code: "ABC123", token: "host" }),
  });
  assert.equal(get("landing").hidden, true);
  assert.equal(get("dashboard").hidden, false);
  const now = Date.now();
  socket.onmessage({
    data: JSON.stringify({ type: "pong", sent: now - 10, server: now - 5 }),
  });
  socket.onmessage({
    data: JSON.stringify({
      type: "state",
      code: "ABC123",
      settings: { threshold: 5, windowMs: 180 },
      simulation: true,
      events: [],
      devices: [
        {
          id: "virtual-0",
          name: "Virtual",
          virtual: true,
          connected: true,
          x: 0,
          y: 0,
          lastSeen: now,
          points: [{ time: now, value: 0.3, noise: 0.02 }],
        },
      ],
    }),
  });
  paint();
  paint();
  assert.equal(get("count").textContent, "01");
  assert.match(get("devices").innerHTML, /Virtual/);
  assert.equal(get("simulate").textContent, "Stop simulation");
  assert.equal(requested, 0);
  const event = {
    id: "event-1",
    time: now,
    participants: [
      { id: "virtual-0", name: "Virtual", time: now, value: 1 },
      { id: "other", name: "Other", time: now + 5, value: 1 },
    ],
    peak: 1,
  };
  socket.onmessage({ data: JSON.stringify({ type: "event", event }) });
  assert.equal(get("eventCount").textContent, "00");
  paint();
  paint();
  assert.equal(get("eventCount").textContent, "01");
  socket.onmessage({ data: JSON.stringify({ type: "event", event }) });
  paint();
  paint();
  assert.equal(get("eventCount").textContent, "01");
  get("mode").value = "eco";
  get("mode").onchange();
  assert.equal(sent.at(-1).mode, "eco");
  get("code").value = "ABC123";
  get("join").onclick();
  socket.onmessage({
    data: JSON.stringify({ type: "joined", code: "ABC123", token: "phone" }),
  });
  assert.equal(get("phone").hidden, false);
  assert.equal(listeners.has("devicemotion"), false);
  await get("enable").onclick();
  assert.equal(requested, 1);
  assert.equal(listeners.has("devicemotion"), true);
  listeners.get("devicemotion")({
    accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 },
  });
  assert.equal(sent.at(-1).type, "samples");
  assert.equal(sent.at(-1).samples.length, 1);
  get("stop").onclick();
  assert.equal(listeners.has("devicemotion"), false);
  window.isSecureContext = false;
  await get("enable").onclick();
  assert.match(get("notice").textContent, /HTTPS/);
  assert.equal(listeners.has("devicemotion"), false);
  window.isSecureContext = true;
  window.DeviceMotionEvent.requestPermission = async () => "denied";
  await get("enable").onclick();
  assert.match(get("notice").textContent, /denied/);
  assert.equal(listeners.has("devicemotion"), false);
});
