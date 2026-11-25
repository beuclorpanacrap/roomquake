import { randomBytes } from "node:crypto";
import { Signal, Events, PROFILES } from "./signal.js";
export const token = () => randomBytes(18).toString("hex");
const SENSOR_STATES = new Set([
  "place_flat",
  "calibrating",
  "ready",
  "moved",
  "paused",
]);

export class Session {
  constructor(code, onEvent = () => {}, onEventUpdate = () => {}) {
    this.onEvent = onEvent;
    this.onEventUpdate = onEventUpdate;
    this.timings = [];
    this.code = code;
    this.hostToken = token();
    this.devices = new Map();
    this.events = [];
    this.eventSeq = 0;
    this.detector = new Events();
    this.settings = { profile: "lab", threshold: 5, windowMs: 180 };
    this.layout = {
      mode: "schematic",
      rotationDeg: 0,
      mirrorX: false,
      confidence: null,
      residualCm: null,
      coords: {},
    };
    this.lastActive = Date.now();
    this.simulation = false;
  }
  join(name, position = null, id = token()) {
    if (this.devices.size >= 24) throw Error("Room is full (24 sensors).");
    const hasPos = position && (position.x != null || position.y != null);
    const device = {
      id,
      secret: token(),
      name: String(name || "Phone").slice(0, 32),
      x: hasPos ? clamp(position.x, 0, 4) : null,
      y: hasPos ? clamp(position.y, 0, 4) : null,
      placement: hasPos ? "manual" : "schematic",
      sensorState: "ready",
      tiltDeg: null,
      stillStd: null,
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
  setSensorStatus(id, { state, tiltDeg, stillStd } = {}) {
    const d = this.devices.get(id);
    if (!d) return null;
    if (state !== undefined) {
      if (!SENSOR_STATES.has(state)) return null;
      d.sensorState = state;
    }
    if (tiltDeg !== undefined) {
      d.tiltDeg =
        tiltDeg !== null && Number.isFinite(Number(tiltDeg))
          ? Number(tiltDeg)
          : null;
    }
    if (stillStd !== undefined) {
      d.stillStd =
        stillStd !== null && Number.isFinite(Number(stillStd))
          ? Number(stillStd)
          : null;
    }
    if (d.sensorState !== "ready") {
      this.detector.pending = this.detector.pending.filter((p) => p.id !== id);
    }
    return d;
  }
  setSettings({ profile, threshold, windowMs } = {}) {
    const nextProfile =
      profile === "lab" || profile === "performance"
        ? profile
        : this.settings.profile;
    const nextThreshold =
      threshold != null ? clamp(threshold, 2, 12) : this.settings.threshold;
    const nextWindowMs =
      windowMs != null
        ? clamp(windowMs, 50, 500)
        : nextProfile !== this.settings.profile
          ? PROFILES[nextProfile].defaultWindowMs
          : this.settings.windowMs;
    this.settings = {
      profile: nextProfile,
      threshold: nextThreshold,
      windowMs: nextWindowMs,
    };
    return this.settings;
  }
  _origin(participants) {
    let virtualCount = 0;
    for (const p of participants) {
      if (this.devices.get(p.id)?.virtual) virtualCount++;
    }
    if (virtualCount === participants.length) return "simulated";
    if (virtualCount === 0) return "live";
    return "mixed";
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
      const p = d.signal.push(
        s.m,
        s.t,
        this.settings.threshold,
        this.settings.profile,
      );
      if (!p) continue;
      p.seq = d.samples + 1;
      d.points.push(p);
      d.samples++;
      d.rateSamples++;
      d.lastSeen = now;
      if (p.trigger && d.sensorState === "ready") {
        const result = this.detector.push(
          { id, name: d.name, x: d.x, y: d.y, time: p.time, value: p.value },
          this.settings.windowMs,
          this.settings.profile,
        );
        if (result?.update) {
          const existing = this.events.find((e) => e.id === result.event.id);
          if (existing) {
            existing.participants = result.event.participants;
            existing.peak = result.event.peak;
            existing.origin = this._origin(existing.participants);
            existing.intensity = clamp(
              (result.event.peak - 0.16) / 2.5,
              0.05,
              1,
            );
            this.onEventUpdate(existing);
          }
        } else if (result) {
          const intensity = clamp((result.peak - 0.16) / 2.5, 0.05, 1);
          const event = {
            ...result,
            id: token(),
            seq: ++this.eventSeq,
            origin: this._origin(result.participants),
            profile: this.settings.profile,
            serverEmittedAt: now,
            intensity,
          };
          if (this.detector.activeEvent) {
            this.detector.activeEvent.id = event.id;
          }
          this.events.unshift(event);
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
      layout: this.layout,
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
