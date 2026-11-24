export class Signal {
  constructor() {
    this.mean = null;
    this.noise = 0.025;
    this.last = -Infinity;
    this.lastTime = null;
  }
  push(magnitude, time, threshold = 5) {
    if (
      !Number.isFinite(magnitude) ||
      !Number.isFinite(time) ||
      (this.lastTime !== null && time <= this.lastTime)
    )
      return null;
    const dt =
      this.lastTime === null ? 20 : Math.min(200, time - this.lastTime);
    this.lastTime = time;
    this.mean ??= magnitude;
    this.mean += (1 - Math.exp(-dt / 300)) * (magnitude - this.mean);
    const value = magnitude - this.mean;
    const limit = Math.max(0.16, this.noise * threshold);
    const trigger = Math.abs(value) > limit && time - this.last > 650;
    if (trigger) this.last = time;
    // Winsorized EWMA prevents an impact from immediately raising the noise floor.
    this.noise +=
      0.015 * (Math.min(Math.abs(value), this.noise * 3) - this.noise);
    this.noise = Math.max(0.015, this.noise);
    return { time, value, noise: this.noise, trigger };
  }
}
export class Events {
  constructor() {
    this.pending = [];
    this.last = -Infinity;
  }
  push(trigger, windowMs = 180) {
    this.pending.push(trigger);
    this.pending = this.pending
      .filter((x) => Math.abs(trigger.time - x.time) <= windowMs)
      .slice(-100);
    const distinct = [...new Map(this.pending.map((x) => [x.id, x])).values()];
    const earliest = Math.min(...distinct.map((x) => x.time));
    if (distinct.length < 2 || earliest - this.last < 700) return null;
    this.last = earliest;
    this.pending = [];
    return {
      time: earliest,
      participants: distinct,
      peak: Math.max(...distinct.map((x) => Math.abs(x.value))),
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
