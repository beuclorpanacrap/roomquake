import { randomBytes } from "node:crypto";
import { Signal, Events } from "./signal.js";
export const token = () => randomBytes(18).toString("hex");
export class Session {
  constructor(code, onEvent = () => {}) {
    this.onEvent = onEvent;
    this.timings = [];
    this.code = code;
    this.hostToken = token();
    this.devices = new Map();
    this.events = [];
    this.detector = new Events();
    this.settings = { threshold: 5, windowMs: 180 };
    this.lastActive = Date.now();
    this.simulation = false;
  }
  join(name, position, id = token()) {
    if (this.devices.size >= 24) throw Error("Room is full (24 sensors).");
    const device = {
      id,
      secret: token(),
      name: String(name || "Phone").slice(0, 32),
      x: clamp(position?.x, 0, 4),
      y: clamp(position?.y, 0, 4),
      connected: true,
      sync: null,
      points: [],
      signal: new Signal(),
      samples: 0,
      lastSeen: Date.now(),
      rate: 0,
      rateStart: Date.now(),
      rateSamples: 0,
      virtual: false,
    };
    this.devices.set(id, device);
    return device;
  }
  ingest(id, samples, now = Date.now()) {
    const started = performance.now();
    const d = this.devices.get(id);
    if (!d || !Array.isArray(samples) || samples.length > 100) return false;
    for (const s of samples) {
      if (
        !s ||
        !Number.isFinite(s.t) ||
        !Number.isFinite(s.m) ||
        s.m < 0 ||
        s.m > 200 ||
        Math.abs(now - s.t) > 5000
      )
        continue;
      const p = d.signal.push(s.m, s.t, this.settings.threshold);
      if (!p) continue;
      p.seq = d.samples + 1;
      d.points.push(p);
      d.samples++;
      d.rateSamples++;
      d.lastSeen = now;
      if (p.trigger) {
        const event = this.detector.push(
          { id, name: d.name, x: d.x, y: d.y, time: p.time, value: p.value },
          this.settings.windowMs,
        );
        if (event) {
          this.events.unshift({ ...event, id: token() });
          this.events.length = Math.min(40, this.events.length);
          this.onEvent(this.events[0]);
        }
      }
    }
    d.points = d.points.slice(-250);
    if (now - d.rateStart >= 1000) {
      d.rate = Math.round((d.rateSamples * 1000) / (now - d.rateStart));
      d.rateStart = now;
      d.rateSamples = 0;
    }
    this.lastActive = now;
    this.timings.push(performance.now() - started);
    if (this.timings.length > 2048) this.timings.shift();
    return true;
  }
  snapshot({ points = true } = {}) {
    const sorted = [...this.timings].sort((a, b) => a - b);
    return {
      processingP95: sorted.length
        ? sorted[Math.floor((sorted.length - 1) * 0.95)]
        : null,
      code: this.code,
      settings: this.settings,
      simulation: this.simulation,
      events: this.events,
      devices: [...this.devices.values()].map(
        ({ signal, rateStart, rateSamples, secret, ...d }) => ({
          ...d,
          bufferCount: d.points.length,
          points: points ? d.points.slice(-160) : undefined,
        }),
      ),
    };
  }
}
export function clamp(n, min, max) {
  return Math.max(
    min,
    Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min),
  );
}
