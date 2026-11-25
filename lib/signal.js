export const PROFILES = {
  lab: {
    tauMs: 300,
    sensorRefractoryMs: 650,
    sharedRefractoryMs: 700,
    defaultWindowMs: 180,
    minLimit: 0.16,
    ringDecayFrac: 0,
    ringJumpFrac: 0,
  },
  performance: {
    tauMs: 250,
    sensorRefractoryMs: 140,
    sharedRefractoryMs: 150,
    defaultWindowMs: 110,
    minLimit: 0.16,
    ringDecayFrac: 0.45,
    ringJumpFrac: 1.35,
  },
};

export class Signal {
  constructor() {
    this.mean = null;
    this.noise = 0.025;
    this.last = -Infinity;
    this.lastTime = null;
    this.envelope = 0;
    this.lastTriggerPeak = 0;
    this.armed = true;
    this.quietMs = 0;
  }
  push(magnitude, time, threshold = 5, profile = "lab") {
    if (
      !Number.isFinite(magnitude) ||
      !Number.isFinite(time) ||
      (this.lastTime !== null && time <= this.lastTime)
    )
      return null;
    const cfg = PROFILES[profile] || PROFILES.lab;
    const rawDt = this.lastTime === null ? 20 : time - this.lastTime;
    const dt = Math.min(200, rawDt);
    this.lastTime = time;
    this.mean ??= magnitude;
    this.mean += (1 - Math.exp(-dt / cfg.tauMs)) * (magnitude - this.mean);
    const value = magnitude - this.mean;
    const absVal = Math.abs(value);
    const limit = Math.max(cfg.minLimit, this.noise * threshold);
    const decayedEnvelope = this.envelope * Math.exp(-rawDt / 120);
    this.envelope = Math.max(absVal, decayedEnvelope);
    let trigger = false;
    if (profile === "performance") {
      // Allow external resets (e.g. simulation immediate impact) to trigger cleanly.
      if (this.last === -Infinity) {
        this.armed = true;
        this.lastTriggerPeak = 0;
      }
      const pastRefractory = time - this.last >= cfg.sensorRefractoryMs;
      const decayGate = Math.max(
        limit * 1.5,
        this.lastTriggerPeak * cfg.ringDecayFrac,
      );
      if (absVal <= limit) {
        this.quietMs += rawDt;
        // Require sustained quiet before re-arming so ringing zero-crossings cannot arm.
        if (pastRefractory && this.quietMs >= 50 && this.envelope <= decayGate)
          this.armed = true;
      } else {
        if (pastRefractory && this.quietMs >= 50 && decayedEnvelope <= decayGate)
          this.armed = true;
        this.quietMs = 0;
      }
      trigger =
        pastRefractory &&
        absVal > limit &&
        (this.armed ||
          absVal > Math.max(limit, decayedEnvelope * cfg.ringJumpFrac));
      if (trigger) {
        this.last = time;
        this.armed = false;
        this.lastTriggerPeak = absVal;
        this.quietMs = 0;
      }
    } else {
      trigger = absVal > limit && time - this.last > cfg.sensorRefractoryMs;
      if (trigger) {
        this.last = time;
        this.armed = false;
        this.lastTriggerPeak = absVal;
        this.quietMs = 0;
      }
    }
    // Winsorized EWMA prevents an impact from immediately raising the noise floor.
    this.noise += 0.015 * (Math.min(absVal, this.noise * 3) - this.noise);
    this.noise = Math.max(0.015, this.noise);
    return { time, value, noise: this.noise, trigger };
  }
}

export class Events {
  constructor() {
    this.pending = [];
    this.last = -Infinity;
    this.activeEvent = null;
  }
  push(trigger, windowMs = 180, profile = "lab") {
    const cfg = PROFILES[profile] || PROFILES.lab;
    if (this.last === -Infinity) this.activeEvent = null;
    if (this.activeEvent && this.last !== -Infinity) {
      const dt = trigger.time - this.activeEvent.time;
      if (dt > windowMs) {
        this.activeEvent = null;
      } else if (dt >= 0) {
        if (!this.activeEvent.participants.some((p) => p.id === trigger.id)) {
          this.activeEvent.participants.push({
            ...trigger,
            delayMs: Math.round(dt),
          });
          this.activeEvent.peak = Math.max(
            this.activeEvent.peak,
            Math.abs(trigger.value),
          );
          return {
            update: true,
            event: {
              ...this.activeEvent,
              participants: [...this.activeEvent.participants],
            },
          };
        }
        if (trigger.time - this.last < cfg.sharedRefractoryMs) return null;
        this.activeEvent = null;
      }
    }
    this.pending.push(trigger);
    this.pending = this.pending
      .filter((x) => Math.abs(trigger.time - x.time) <= windowMs)
      .slice(-100);
    const distinct = [...new Map(this.pending.map((x) => [x.id, x])).values()];
    const earliest = Math.min(...distinct.map((x) => x.time));
    if (distinct.length < 2 || earliest - this.last < cfg.sharedRefractoryMs)
      return null;
    this.last = earliest;
    this.pending = [];
    const participants = distinct.map((x) => ({
      ...x,
      delayMs: Math.round(x.time - earliest),
    }));
    const peak = Math.max(...distinct.map((x) => Math.abs(x.value)));
    this.activeEvent = {
      id: null,
      time: earliest,
      participants: [...participants],
      peak,
    };
    return {
      time: earliest,
      participants,
      peak,
    };
  }
}
export function estimateClock(samples) {
  const valid = samples
    .filter(
      (s) =>
        [s.sent, s.received, s.server].every(Number.isFinite) &&
        s.received >= s.sent,
    )
    .map((s) => ({
      rtt: s.received - s.sent,
      offset: s.server - (s.sent + s.received) / 2,
    }))
    .sort((a, b) => a.rtt - b.rtt)
    .slice(0, 5);
  if (!valid.length) return null;
  const offsets = valid.map((s) => s.offset).sort((a, b) => a - b);
  const offset = offsets[Math.floor(offsets.length / 2)];
  return {
    offset,
    uncertainty: Math.max(
      1,
      ...valid.map((s) => Math.abs(s.offset - offset) + s.rtt / 2),
    ),
    rtt: valid[0].rtt,
  };
}
