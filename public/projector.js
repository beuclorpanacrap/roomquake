/**
 * ProjectorStage — Live room wavefield stage and aligned trace strip renderer.
 *
 * Renders connected sensors in either an honest schematic symmetry ring
 * ("SCHEMATIC LAYOUT") or calibrated relative coordinates ("MEASURED RELATIVE LAYOUT"),
 * overlapping harmonic interference ripples for shared impacts, subtle local amber
 * twitch pulses for isolated single-phone bumps, and an aligned +/-1.5 m/s^2 trace strip.
 */

const VALID_STATES = new Set([
  "ready",
  "calibrating",
  "place_flat",
  "moved",
  "paused",
  "disconnected",
  "virtual",
]);

const STATE_STYLES = {
  ready: {
    color: "#88dcd2",
    fill: "#17342f",
    ring: "rgba(136, 220, 210, 0.9)",
    tag: "READY",
  },
  virtual: {
    color: "#d3ed91",
    fill: "#23341b",
    ring: "rgba(211, 237, 145, 0.92)",
    tag: "VIRTUAL",
  },
  calibrating: {
    color: "#f0c45a",
    fill: "#332a14",
    ring: "rgba(240, 196, 90, 0.9)",
    tag: "CALIBRATING",
  },
  place_flat: {
    color: "#eb9342",
    fill: "#372112",
    ring: "rgba(235, 147, 66, 0.92)",
    tag: "PLACE FLAT",
  },
  moved: {
    color: "#f06a4a",
    fill: "#3a1914",
    ring: "rgba(240, 106, 74, 0.95)",
    tag: "MOVED",
  },
  paused: {
    color: "#83948b",
    fill: "#16201b",
    ring: "rgba(131, 148, 139, 0.7)",
    tag: "PAUSED",
  },
  disconnected: {
    color: "#6a7b73",
    fill: "#141c18",
    ring: "rgba(106, 123, 115, 0.55)",
    tag: "OFFLINE",
  },
};

const isFiniteCoord = (c) =>
  c != null && Number.isFinite(c.x) && Number.isFinite(c.y);

function resolveDeviceState(d) {
  if (!d || d.connected === false) return "disconnected";
  if (d.status === "disconnected" || d.state === "disconnected") {
    return "disconnected";
  }
  if (d.virtual || d.status === "virtual" || d.state === "virtual") {
    return "virtual";
  }
  const explicit = d.status ?? d.state ?? d.sensorState ?? d.calibration?.state;
  if (VALID_STATES.has(explicit)) return explicit;
  if (d.moved === true || d.calibration?.moved === true) return "moved";
  if (
    d.placeFlat === true ||
    d.flat === false ||
    d.isFlat === false ||
    d.calibration?.flat === false
  ) {
    return "place_flat";
  }
  if (d.calibrating === true || d.calibration?.calibrating === true || !d.sync) {
    return "calibrating";
  }
  return "ready";
}

function getCanvasMetrics(canvas, fallbackW, fallbackH) {
  const width = Math.max(120, Number(canvas.clientWidth) || Number(canvas.width) || fallbackW);
  const height = Math.max(80, Number(canvas.clientHeight) || Number(canvas.height) || fallbackH);
  const dpr = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
  if (
    canvas.clientWidth > 0 &&
    (canvas.width !== Math.round(width * dpr) ||
      canvas.height !== Math.round(height * dpr))
  ) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  return { width, height, dpr };
}

function setDash(ctx, pattern) {
  if (typeof ctx.setLineDash === "function") ctx.setLineDash(pattern);
}

function drawRoundedBadge(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

export class ProjectorStage {
  /**
   * @param {{
   *   canvas?: HTMLCanvasElement | null,
   *   traceCanvas?: HTMLCanvasElement | null,
   *   onNodePositions?: ((positions: Array<object>, meta: { mode: string }) => void) | null
   * }} [options]
   */
  constructor({ canvas = null, traceCanvas = null, onNodePositions = null } = {}) {
    this.canvas = canvas;
    this.traceCanvas = traceCanvas;
    this.onNodePositions = onNodePositions;
    this.eco = false;
    this.state = null;
    this.ripples = [];
    this._rippleSeq = 0;
    this._lastServerNowMs = null;
    this._lastFrameTimeMs = null;
    this._lastPositions = [];
    this._lastPositionsKey = "";
    this._lastLayoutMode = "SCHEMATIC LAYOUT";
  }

  /**
   * Toggles lighter graphics mode (disables shadowBlur and reduces ring density).
   * @param {boolean} enabled
   */
  setEco(enabled) {
    this.eco = Boolean(enabled);
  }

  /**
   * Consumes a host state snapshot and updates computed node layout.
   * @param {object} state
   * @param {number} [now]
   */
  setState(state, now = Date.now()) {
    this.state = state || null;
    if (Number.isFinite(now)) this._lastServerNowMs = now;
    const width = Math.max(
      120,
      Number(this.canvas?.clientWidth) || Number(this.canvas?.width) || 800,
    );
    const height = Math.max(
      80,
      Number(this.canvas?.clientHeight) || Number(this.canvas?.height) || 500,
    );
    this._computeNodePositions(width, height);
  }

  clearRipples() {
    this.ripples = [];
  }

  getLayoutMode() {
    return this._lastLayoutMode;
  }

  getNodePositions() {
    return this._lastPositions.map((p) => ({ ...p }));
  }

  getActiveRipples() {
    return this.ripples.map((r) => ({
      id: r.id,
      time: r.time,
      decaySec: r.decaySec,
      peak: r.peak,
      participants: [...r.participants.values()].map((p) => ({ ...p })),
    }));
  }

  /**
   * Triggers a primary stage ripple from a confirmed live or auditioned event.
   * @param {object} event
   * @param {number} [decaySec=2.4]
   */
  triggerRipple(event, decaySec = 2.4) {
    if (!event) return null;
    if (event.id && this.ripples.some((r) => r.id === event.id)) {
      this.enrichRipple(event);
      return this.ripples.find((r) => r.id === event.id);
    }

    const participants = Array.isArray(event.participants)
      ? event.participants
      : [];
    const participantTimes = participants
      .map((p) => p?.time)
      .filter(Number.isFinite);
    const earliestTime = participantTimes.length
      ? Math.min(...participantTimes)
      : Number.isFinite(event.time)
        ? event.time
        : this._lastServerNowMs;

    const ripple = {
      id: event.id ?? `ripple-${++this._rippleSeq}`,
      time: earliestTime,
      startedServerMs: Number.isFinite(event.time)
        ? event.time
        : Number.isFinite(earliestTime)
          ? earliestTime
          : this._lastServerNowMs,
      startedFrameMs: this._lastFrameTimeMs,
      decaySec: Math.max(0.25, Number(decaySec) || 2.4),
      peak: Math.max(0.2, Math.min(8, Number(event.peak) || 1.0)),
      participants: new Map(),
    };

    for (const p of participants) {
      if (!p?.id) continue;
      ripple.participants.set(p.id, {
        id: p.id,
        name: p.name || p.id,
        time: Number.isFinite(p.time) ? p.time : earliestTime,
        value: Number.isFinite(p.value) ? p.value : ripple.peak,
        isLate: false,
        joinedOffsetSec: 0,
      });
    }

    this.ripples.push(ripple);
    if (this.ripples.length > 24) this.ripples.shift();
    return ripple;
  }

  /**
   * Enriches an already-active ripple when 3rd/4th sensors confirm late,
   * adding participant node highlights and secondary halo waves without resetting decay.
   * @param {object} eventUpdate
   * @returns {boolean}
   */
  enrichRipple(eventUpdate) {
    if (!eventUpdate?.id) return false;
    const ripple = this.ripples.find((r) => r.id === eventUpdate.id);
    if (!ripple) return false;

    if (Number.isFinite(eventUpdate.peak)) {
      ripple.peak = Math.max(ripple.peak, Math.min(8, eventUpdate.peak));
    }

    const participants = Array.isArray(eventUpdate.participants)
      ? eventUpdate.participants
      : [];
    let added = false;

    for (const p of participants) {
      if (!p?.id || ripple.participants.has(p.id)) continue;
      let joinedOffsetSec = 0;
      if (
        Number.isFinite(p.time) &&
        Number.isFinite(ripple.startedServerMs)
      ) {
        joinedOffsetSec = Math.max(
          0,
          Math.min(ripple.decaySec * 0.65, (p.time - ripple.startedServerMs) / 1000),
        );
      } else if (
        Number.isFinite(this._lastServerNowMs) &&
        Number.isFinite(ripple.startedServerMs)
      ) {
        joinedOffsetSec = Math.max(
          0,
          Math.min(
            ripple.decaySec * 0.65,
            (this._lastServerNowMs - ripple.startedServerMs) / 1000,
          ),
        );
      }

      ripple.participants.set(p.id, {
        id: p.id,
        name: p.name || p.id,
        time: Number.isFinite(p.time) ? p.time : ripple.time,
        value: Number.isFinite(p.value) ? p.value : ripple.peak,
        isLate: true,
        joinedOffsetSec,
      });
      added = true;
    }

    return added;
  }

  /**
   * Detects when a single sensor has a local acceleration spike (|value| > 0.25)
   * within the last 300 ms that is NOT linked to any shared ripple.
   * @param {number} nowServerMs
   * @returns {Array<{ id: string, peak: number, time: number }>}
   */
  getIsolatedBumpIds(nowServerMs) {
    const devices = this.state?.devices;
    if (!Array.isArray(devices) || !Number.isFinite(nowServerMs)) return [];
    const cutoff = nowServerMs - 300;
    const spiking = [];

    for (const d of devices) {
      if (!d || d.connected === false || !Array.isArray(d.points)) continue;
      let maxVal = 0;
      let spikeTime = null;
      for (const pt of d.points) {
        if (!pt || !Number.isFinite(pt.time) || !Number.isFinite(pt.value)) continue;
        if (pt.time >= cutoff && pt.time <= nowServerMs + 60) {
          const mag = Math.abs(pt.value);
          if (mag > 0.25 && mag >= maxVal) {
            maxVal = mag;
            spikeTime = pt.time;
          }
        }
      }
      if (spikeTime !== null) {
        spiking.push({ id: d.id, peak: maxVal, time: spikeTime });
      }
    }

    if (spiking.length !== 1) return [];
    const candidate = spiking[0];

    const linkedToRipple = this.ripples.some((r) => {
      const p = r.participants.get(candidate.id);
      if (!p) return false;
      const refTime = Number.isFinite(p.time) ? p.time : r.time;
      return !Number.isFinite(refTime) || Math.abs(candidate.time - refTime) <= 500;
    });
    if (linkedToRipple) return [];

    const linkedToRecentEvent = (this.state?.events || []).some((evt) => {
      if (!evt || !Array.isArray(evt.participants)) return false;
      const p = evt.participants.find((item) => item.id === candidate.id);
      if (!p) return false;
      const refTime = Number.isFinite(p.time) ? p.time : evt.time;
      return Number.isFinite(refTime) && Math.abs(candidate.time - refTime) <= 500;
    });
    if (linkedToRecentEvent) return [];

    return [candidate];
  }

  _computeNodePositions(width, height) {
    const devices = Array.isArray(this.state?.devices) ? this.state.devices : [];
    const layout = this.state?.layout;
    const coords = layout?.coords;

    const padX = Math.max(56, width * 0.14);
    const padTop = Math.max(62, height * 0.17);
    const padBottom = Math.max(58, height * 0.16);
    const cx = width / 2;
    const cy = padTop + (height - padTop - padBottom) / 2;
    const availW = Math.max(120, width - padX * 2);
    const availH = Math.max(100, height - padTop - padBottom);

    const measuredEntries = devices.filter((d) => isFiniteCoord(coords?.[d.id]));
    const useMeasured =
      layout?.mode === "measured" &&
      coords &&
      typeof coords === "object" &&
      (devices.length === 0
        ? Object.values(coords).some(isFiniteCoord)
        : measuredEntries.length > 0);

    const modeLabel = useMeasured
      ? "MEASURED RELATIVE LAYOUT"
      : "SCHEMATIC LAYOUT";
    this._lastLayoutMode = modeLabel;

    let positions = [];

    if (useMeasured && measuredEntries.length > 0) {
      const rawCoords = measuredEntries.map((d) => coords[d.id]);
      const allUnitRange = rawCoords.every(
        (c) => c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1,
      );
      const rotRad = ((Number(layout.rotationDeg) || 0) * Math.PI) / 180;
      const cosR = Math.cos(rotRad);
      const sinR = Math.sin(rotRad);
      const mirrorX = Boolean(layout.mirrorX);

      const transformed = new Map();
      let maxExtent = allUnitRange ? 0.5 : 0.25;

      for (const d of measuredEntries) {
        const c = coords[d.id];
        let nx = allUnitRange ? c.x - 0.5 : c.x;
        let ny = allUnitRange ? c.y - 0.5 : c.y;
        // Match lib/acoustics.js transformLayout: mirrorX before rotationDeg.
        if (mirrorX) nx = -nx;
        if (rotRad !== 0) {
          const rx = nx * cosR - ny * sinR;
          const ry = nx * sinR + ny * cosR;
          nx = rx;
          ny = ry;
        }
        maxExtent = Math.max(maxExtent, Math.abs(nx), Math.abs(ny));
        transformed.set(d.id, { nx, ny });
      }

      const scale = (Math.min(availW, availH) * 0.46) / maxExtent;
      const unmeasured = devices.filter((d) => !transformed.has(d.id));
      let fallbackIdx = 0;

      positions = devices.map((d, index) => {
        const state = resolveDeviceState(d);
        const t = transformed.get(d.id);
        let x;
        let y;
        if (t) {
          x = cx + t.nx * scale;
          y = cy + t.ny * scale;
        } else {
          const span = Math.max(1, unmeasured.length);
          const slot = fallbackIdx++;
          x = width - padX * 0.65 - (span - 1 - slot) * 44;
          y = height - padBottom * 0.45;
        }
        return {
          id: d.id,
          index,
          name: d.name || `S${index + 1}`,
          x,
          y,
          normX: x / width,
          normY: y / height,
          state,
          connected: d.connected !== false,
          virtual: Boolean(d.virtual),
          measured: Boolean(t),
        };
      });
    } else {
      // Schematic layout: symmetric ellipse ring (no fake physical XY grid).
      const count = devices.length;
      const rx = availW * 0.38;
      const ry = availH * 0.38;
      const startAngle = count > 1 ? -Math.PI / 2 - Math.PI / count : 0;

      positions = devices.map((d, index) => {
        const state = resolveDeviceState(d);
        let x = cx;
        let y = cy;
        if (count > 1) {
          const angle = startAngle + (index * 2 * Math.PI) / count;
          x = cx + rx * Math.cos(angle);
          y = cy + ry * Math.sin(angle);
        }
        return {
          id: d.id,
          index,
          name: d.name || `S${index + 1}`,
          x,
          y,
          normX: x / width,
          normY: y / height,
          state,
          connected: d.connected !== false,
          virtual: Boolean(d.virtual),
          measured: false,
        };
      });
    }

    this._lastPositions = positions;
    const key =
      `${modeLabel}|${width}x${height}|` +
      positions
        .map((p) => `${p.id}:${p.x.toFixed(1)},${p.y.toFixed(1)}:${p.state}`)
        .join(";");

    if (key !== this._lastPositionsKey) {
      this._lastPositionsKey = key;
      if (typeof this.onNodePositions === "function") {
        this.onNodePositions(
          positions.map((p) => ({ ...p })),
          { mode: modeLabel },
        );
      }
    }
    return { positions, modeLabel, cx, cy, availW, availH };
  }

  _pruneAndMeasureRipples(frameTimeMs, nowServerMs) {
    const hasServerClock = Number.isFinite(nowServerMs);
    const active = [];
    for (const r of this.ripples) {
      if (hasServerClock && !Number.isFinite(r.startedServerMs)) {
        r.startedServerMs = nowServerMs;
      }
      if (!Number.isFinite(r.startedFrameMs) && Number.isFinite(frameTimeMs)) {
        r.startedFrameMs = frameTimeMs;
      }
      const ageMs =
        hasServerClock && Number.isFinite(r.startedServerMs)
          ? nowServerMs - r.startedServerMs
          : Number.isFinite(frameTimeMs) && Number.isFinite(r.startedFrameMs)
            ? frameTimeMs - r.startedFrameMs
            : 0;
      const ageSec = Math.max(0, ageMs / 1000);
      if (ageSec < r.decaySec) {
        active.push({ ripple: r, ageSec });
      }
    }
    this.ripples = active.map((entry) => entry.ripple);
    return active;
  }

  /**
   * Renders both the main stage canvas and the compact aligned trace canvas.
   * @param {number} [frameTimeMs=performance.now()]
   * @param {number} [nowServerMs]
   */
  draw(frameTimeMs = performance.now(), nowServerMs = undefined) {
    this._lastFrameTimeMs = Number.isFinite(frameTimeMs)
      ? frameTimeMs
      : performance.now();
    if (Number.isFinite(nowServerMs)) {
      this._lastServerNowMs = nowServerMs;
    }
    const effectiveServerMs = Number.isFinite(nowServerMs)
      ? nowServerMs
      : (this._lastServerNowMs ?? Date.now());

    const activeRipples = this._pruneAndMeasureRipples(
      this._lastFrameTimeMs,
      nowServerMs,
    );

    if (this.canvas && typeof this.canvas.getContext === "function") {
      this._drawStage(
        this.canvas,
        this._lastFrameTimeMs,
        effectiveServerMs,
        activeRipples,
      );
    }
    if (this.traceCanvas && typeof this.traceCanvas.getContext === "function") {
      this._drawTraces(this.traceCanvas, effectiveServerMs, activeRipples);
    }
  }

  _drawStage(canvas, frameTimeMs, nowServerMs, activeRipples) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height, dpr } = getCanvasMetrics(canvas, 800, 500);
    if (typeof ctx.setTransform === "function") {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Background stage field.
    if (!this.eco && typeof ctx.createRadialGradient === "function") {
      const bg = ctx.createRadialGradient(
        width * 0.5,
        height * 0.48,
        24,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.72,
      );
      bg.addColorStop(0, "#15251e");
      bg.addColorStop(0.6, "#0f1a15");
      bg.addColorStop(1, "#09110d");
      ctx.fillStyle = bg;
    } else {
      ctx.fillStyle = "#0d1712";
    }
    ctx.fillRect(0, 0, width, height);

    const { positions, modeLabel, cx, cy, availW, availH } =
      this._computeNodePositions(width, height);
    const posById = new Map(positions.map((p) => [p.id, p]));
    const devices = Array.isArray(this.state?.devices) ? this.state.devices : [];
    const deviceById = new Map(devices.map((d) => [d.id, d]));

    // Subtle geometric field guides (radial ring in schematic, relative axes in measured).
    this._drawFieldGuides(ctx, width, height, cx, cy, availW, availH, modeLabel);

    // Active overlapping wavefield ripples.
    for (const { ripple, ageSec } of activeRipples) {
      this._drawRipple(
        ctx,
        ripple,
        ageSec,
        posById,
        width,
        height,
        cx,
        cy,
      );
    }

    // Isolated single-phone bump pulse (strictly local, calm room field).
    const isolatedBumps = this.getIsolatedBumpIds(nowServerMs);
    for (const bump of isolatedBumps) {
      const pos = posById.get(bump.id);
      if (!pos) continue;
      const ageMs = Math.max(0, nowServerMs - bump.time);
      const t = Math.min(1, ageMs / 300);
      const alpha = (1 - t) * 0.75;
      ctx.save?.();
      setDash(ctx, [4, 4]);
      ctx.strokeStyle = `rgba(226, 152, 68, ${alpha.toFixed(3)})`;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 19 + t * 14, 0, Math.PI * 2);
      ctx.stroke();
      setDash(ctx, []);
      ctx.fillStyle = `rgba(226, 152, 68, ${(alpha * 0.95).toFixed(3)})`;
      ctx.font = "600 9px ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText("LOCAL BUMP", pos.x, pos.y - 26);
      ctx.restore?.();
    }

    // Sensor nodes + live energy ring + onset badges.
    this._drawNodes(
      ctx,
      positions,
      deviceById,
      activeRipples,
      frameTimeMs,
      nowServerMs,
    );

    // Stage HUD badges (layout mode, simulation state, eco status).
    this._drawHud(ctx, width, height, modeLabel, positions);
  }

  _drawFieldGuides(ctx, width, height, cx, cy, availW, availH, modeLabel) {
    ctx.save?.();
    ctx.lineWidth = 1;
    if (modeLabel === "MEASURED RELATIVE LAYOUT") {
      ctx.strokeStyle = "rgba(136, 220, 210, 0.08)";
      ctx.beginPath();
      ctx.moveTo(cx - availW * 0.48, cy);
      ctx.lineTo(cx + availW * 0.48, cy);
      ctx.moveTo(cx, cy - availH * 0.48);
      ctx.lineTo(cx, cy + availH * 0.48);
      ctx.stroke();
      const box = Math.min(availW, availH) * 0.46;
      setDash(ctx, [4, 6]);
      ctx.strokeRect(cx - box, cy - box, box * 2, box * 2);
      setDash(ctx, []);
    } else {
      // Polar schematic guide ellipses — explicitly avoids fake XY grid.
      const rx = availW * 0.38;
      const ry = availH * 0.38;
      ctx.strokeStyle = "rgba(182, 212, 194, 0.08)";
      for (const factor of [0.42, 0.72, 1.0]) {
        setDash(ctx, factor === 1.0 ? [] : [3, 6]);
        ctx.beginPath();
        if (typeof ctx.ellipse === "function") {
          ctx.ellipse(cx, cy, rx * factor, ry * factor, 0, 0, Math.PI * 2);
        } else {
          ctx.arc(cx, cy, Math.min(rx, ry) * factor, 0, Math.PI * 2);
        }
        ctx.stroke();
      }
      setDash(ctx, []);
    }
    ctx.restore?.();
  }

  _drawRipple(ctx, ripple, ageSec, posById, width, height, fallbackCx, fallbackCy) {
    const progress = Math.min(1, ageSec / ripple.decaySec);
    const env = Math.pow(1 - progress, 1.55);
    const participants = [...ripple.participants.values()];
    const activeNodes = participants
      .map((p) => ({ p, pos: posById.get(p.id) }))
      .filter((entry) => entry.pos);

    const cx = activeNodes.length
      ? activeNodes.reduce((sum, entry) => sum + entry.pos.x, 0) / activeNodes.length
      : fallbackCx;
    const cy = activeNodes.length
      ? activeNodes.reduce((sum, entry) => sum + entry.pos.y, 0) / activeNodes.length
      : fallbackCy;

    const minDim = Math.min(width, height);
    const maxR = minDim * (0.42 + Math.min(0.14, ripple.peak * 0.04));

    ctx.save?.();

    // Central harmonic interference glow & expanding rings.
    if (!this.eco && typeof ctx.createRadialGradient === "function") {
      const glowR = Math.max(24, maxR * (0.32 + progress * 0.65));
      const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, glowR);
      grad.addColorStop(0, `rgba(211, 237, 145, ${(0.22 * env).toFixed(3)})`);
      grad.addColorStop(0.45, `rgba(136, 220, 210, ${(0.11 * env).toFixed(3)})`);
      grad.addColorStop(1, "rgba(136, 220, 210, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Interference chord lines from confirming sensors to centroid.
    if (activeNodes.length >= 2) {
      ctx.strokeStyle = `rgba(136, 220, 210, ${(0.28 * env).toFixed(3)})`;
      ctx.lineWidth = 1.25;
      for (const { pos } of activeNodes) {
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
        ctx.lineTo(cx, cy);
        ctx.stroke();
      }
    }

    const centralRings = this.eco ? 1 : 3;
    for (let k = 0; k < centralRings; k++) {
      const pK = Math.max(0, Math.min(1, progress - k * 0.08));
      if (pK <= 0) continue;
      const envK = Math.pow(1 - pK, 1.55);
      const radius = 14 + pK * maxR;
      ctx.strokeStyle =
        k === 0
          ? `rgba(211, 237, 145, ${(0.75 * envK).toFixed(3)})`
          : `rgba(136, 220, 210, ${(0.55 * envK).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, (2.6 - k * 0.55) * envK);
      if (!this.eco) {
        ctx.shadowBlur = 14 * envK;
        ctx.shadowColor = "rgba(136, 220, 210, 0.55)";
      }
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
      if (!this.eco) ctx.shadowBlur = 0;
    }

    // Individual participant source waves + glowing participant halos.
    const nodeWaves = this.eco ? 1 : 2;
    const nodeMaxR = minDim * 0.3;
    for (const { p, pos } of activeNodes) {
      const localAge = Math.max(0, ageSec - (p.joinedOffsetSec || 0));
      const localDur = Math.max(0.25, ripple.decaySec - (p.joinedOffsetSec || 0));
      const pProg = Math.min(1, localAge / localDur);
      const pEnv = Math.pow(1 - pProg, 1.45);

      // Confirming participant node halo (glows for decaySec).
      if (!this.eco) {
        ctx.shadowBlur = 18 * pEnv;
        ctx.shadowColor = p.isLate
          ? "rgba(136, 220, 210, 0.85)"
          : "rgba(211, 237, 145, 0.85)";
      }
      ctx.strokeStyle = p.isLate
        ? `rgba(136, 220, 210, ${(0.88 * pEnv).toFixed(3)})`
        : `rgba(211, 237, 145, ${(0.92 * pEnv).toFixed(3)})`;
      ctx.lineWidth = 2.4 * pEnv + 0.8;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 18 + (1 - pEnv) * 6, 0, Math.PI * 2);
      ctx.stroke();
      if (!this.eco) ctx.shadowBlur = 0;

      // Expanding source rings from confirming participant.
      for (let w = 0; w < nodeWaves; w++) {
        const wProg = Math.max(0, Math.min(1, pProg - w * 0.12));
        if (wProg <= 0) continue;
        const wEnv = Math.pow(1 - wProg, 1.5);
        const r = 16 + wProg * nodeMaxR;
        ctx.strokeStyle = p.isLate
          ? `rgba(136, 220, 210, ${(0.58 * wEnv).toFixed(3)})`
          : `rgba(211, 237, 145, ${(0.52 * wEnv).toFixed(3)})`;
        ctx.lineWidth = Math.max(0.9, (2.0 - w * 0.5) * wEnv);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore?.();
  }

  _drawNodes(ctx, positions, deviceById, activeRipples, frameTimeMs, nowServerMs) {
    // Determine latest active ripple badge per participant.
    const badgeById = new Map();
    for (const { ripple, ageSec } of activeRipples) {
      if (ageSec >= Math.min(ripple.decaySec, 2.2)) continue;
      const times = [...ripple.participants.values()]
        .map((p) => p.time)
        .filter(Number.isFinite);
      const earliest = times.length ? Math.min(...times) : ripple.time;
      for (const p of ripple.participants.values()) {
        const deltaMs =
          Number.isFinite(p.time) && Number.isFinite(earliest)
            ? Math.max(0, Math.round(p.time - earliest))
            : 0;
        const alpha = Math.min(1, (Math.min(ripple.decaySec, 2.2) - ageSec) / 0.4);
        badgeById.set(p.id, { text: `+${deltaMs} ms`, alpha, isLate: p.isLate });
      }
    }

    for (const pos of positions) {
      const style = STATE_STYLES[pos.state] || STATE_STYLES.ready;
      const device = deviceById.get(pos.id);
      const recentPeak = Array.isArray(device?.points)
        ? Math.max(
            0,
            ...device.points
              .filter(
                (pt) =>
                  pt &&
                  Number.isFinite(pt.time) &&
                  nowServerMs - pt.time <= 250 &&
                  nowServerMs - pt.time >= -50,
              )
              .map((pt) => Math.abs(pt.value || 0)),
          )
        : 0;
      const pulseR = pos.state === "disconnected" ? 0 : Math.min(7, recentPeak * 2.5);
      const radius = 12;

      ctx.save?.();
      if (pos.state === "disconnected") ctx.globalAlpha = 0.45;

      // Outer state indicator ring.
      ctx.strokeStyle = style.ring;
      ctx.lineWidth = pos.state === "moved" ? 2.4 : 1.8;

      if (pos.state === "disconnected" || pos.state === "paused") {
        setDash(ctx, [3, 3]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
        setDash(ctx, []);
      } else if (pos.state === "calibrating") {
        const sweep = ((frameTimeMs || 0) / 450) % (Math.PI * 2);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 5 + pulseR, sweep, sweep + Math.PI * 1.35);
        ctx.stroke();
      } else if (pos.state === "virtual") {
        setDash(ctx, [4, 3]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 5 + pulseR, 0, Math.PI * 2);
        ctx.stroke();
        setDash(ctx, []);
      } else if (pos.state === "place_flat") {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(pos.x - 16, pos.y + 4);
        ctx.lineTo(pos.x + 16, pos.y - 4);
        ctx.stroke();
      } else if (pos.state === "moved") {
        const dR = radius + 6;
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - dR);
        ctx.lineTo(pos.x + dR, pos.y);
        ctx.lineTo(pos.x, pos.y + dR);
        ctx.lineTo(pos.x - dR, pos.y);
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 4 + pulseR, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Node core.
      ctx.fillStyle = style.fill;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Inner state pip.
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, pos.state === "disconnected" ? 2.5 : 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Node name & state label beneath node.
      const displayName =
        pos.name.length > 18 ? `${pos.name.slice(0, 17)}…` : pos.name;
      ctx.textAlign = "center";
      ctx.fillStyle = "#e6efe8";
      ctx.font = "600 12px Arial, Helvetica, sans-serif";
      ctx.fillText(displayName, pos.x, pos.y + radius + 21);

      ctx.fillStyle = style.color;
      ctx.font = "600 9px ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.fillText(`S${pos.index + 1} · ${style.tag}`, pos.x, pos.y + radius + 34);

      // Brief +XX ms onset badge above confirming node.
      const badge = badgeById.get(pos.id);
      if (badge && badge.alpha > 0.05) {
        ctx.globalAlpha = badge.alpha;
        ctx.fillStyle = badge.isLate ? "#112f31" : "#22341a";
        drawRoundedBadge(ctx, pos.x - 28, pos.y - radius - 26, 56, 17, 4);
        ctx.fill();
        ctx.strokeStyle = badge.isLate ? "#88dcd2" : "#d3ed91";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = badge.isLate ? "#88dcd2" : "#d3ed91";
        ctx.font = "700 10px ui-monospace, SFMono-Regular, Consolas, monospace";
        ctx.fillText(badge.text, pos.x, pos.y - radius - 14);
      }

      ctx.globalAlpha = 1;
      ctx.restore?.();
    }
  }

  _drawHud(ctx, width, height, modeLabel, positions) {
    ctx.save?.();
    ctx.font = "600 10px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "left";
    ctx.fillStyle =
      modeLabel === "MEASURED RELATIVE LAYOUT" ? "#88dcd2" : "#b8cbc0";
    ctx.fillText(modeLabel, 18, 24);

    if (this.state?.simulation) {
      ctx.fillStyle = "#d3ed91";
      ctx.fillText("VIRTUAL ARRAY · SIMULATION", 18, 40);
    } else if (
      modeLabel === "MEASURED RELATIVE LAYOUT" &&
      Number.isFinite(this.state?.layout?.residualCm)
    ) {
      ctx.fillStyle = "#9eb2a6";
      ctx.fillText(
        `RESIDUAL ±${this.state.layout.residualCm.toFixed(1)} cm${this.state.layout.confidence ? ` · ${String(this.state.layout.confidence).toUpperCase()} CONF` : ""}`,
        18,
        40,
      );
    }

    ctx.textAlign = "right";
    const rightTags = [];
    if (this.eco) rightTags.push("ECO MODE");
    const activeCount = positions.filter((p) => p.connected).length;
    rightTags.push(`${String(activeCount).padStart(2, "0")} ACTIVE`);
    ctx.fillStyle = "#9eb2a6";
    ctx.fillText(rightTags.join(" · "), width - 18, 24);

    if (positions.length === 0) {
      ctx.textAlign = "center";
      ctx.fillStyle = "#dce6df";
      ctx.font = "500 18px Arial, Helvetica, sans-serif";
      ctx.fillText("Awaiting connected sensors", width / 2, height / 2 - 6);
      ctx.fillStyle = "#889b90";
      ctx.font = "12px ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.fillText(
        "Scan the room QR on phones or launch the virtual array",
        width / 2,
        height / 2 + 16,
      );
    }
    ctx.restore?.();
  }

  _drawTraces(canvas, nowServerMs, activeRipples) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height, dpr } = getCanvasMetrics(canvas, 800, 160);
    if (typeof ctx.setTransform === "function") {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    ctx.fillStyle = "#0b1410";
    ctx.fillRect(0, 0, width, height);

    ctx.save?.();
    ctx.font = "600 9px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.fillStyle = "#95aa9e";
    ctx.textAlign = "left";
    ctx.fillText("ALIGNED TRACES · 3.0 s WINDOW", 14, 15);
    ctx.textAlign = "right";
    ctx.fillText(
      this.eco ? "SCALE ±1.5 m/s² · ECO" : "SCALE ±1.5 m/s²",
      width - 14,
      15,
    );

    const devices = Array.isArray(this.state?.devices) ? this.state.devices : [];
    if (devices.length === 0) {
      ctx.textAlign = "center";
      ctx.fillStyle = "#6c7f74";
      ctx.font = "11px ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.fillText("No active vibration waveforms", width / 2, height / 2 + 6);
      ctx.restore?.();
      return;
    }

    const labelW = Math.min(168, Math.max(108, width * 0.2));
    const plotX = labelW;
    const plotW = Math.max(60, width - labelW - 14);
    const plotTop = 24;
    const plotH = Math.max(36, height - plotTop - 8);

    // 1-second aligned grid markers (-3s, -2s, -1s, NOW).
    ctx.strokeStyle = "rgba(136, 175, 155, 0.12)";
    ctx.lineWidth = 1;
    for (let s = 0; s <= 3; s++) {
      const gx = plotX + (plotW * s) / 3;
      ctx.beginPath();
      ctx.moveTo(gx, plotTop);
      ctx.lineTo(gx, plotTop + plotH);
      ctx.stroke();
    }

    // Ripple onset markers across the aligned time axis.
    for (const { ripple } of activeRipples) {
      if (!Number.isFinite(ripple.time)) continue;
      const rx = plotX + plotW * (1 - (nowServerMs - ripple.time) / 3000);
      if (rx >= plotX && rx <= plotX + plotW) {
        ctx.strokeStyle = "rgba(211, 237, 145, 0.38)";
        setDash(ctx, [3, 3]);
        ctx.beginPath();
        ctx.moveTo(rx, plotTop);
        ctx.lineTo(rx, plotTop + plotH);
        ctx.stroke();
        setDash(ctx, []);
      }
    }

    const laneCount = devices.length;
    const laneH = plotH / laneCount;
    const ampScale = (laneH * 0.42) / 1.5;

    devices.forEach((d, idx) => {
      const state = resolveDeviceState(d);
      const style = STATE_STYLES[state] || STATE_STYLES.ready;
      const laneTop = plotTop + idx * laneH;
      const midY = laneTop + laneH / 2;

      // Baseline.
      ctx.strokeStyle = "rgba(72, 102, 86, 0.42)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotX, midY);
      ctx.lineTo(plotX + plotW, midY);
      ctx.stroke();

      // Label in left gutter.
      ctx.textAlign = "left";
      ctx.fillStyle = style.color;
      ctx.font = "600 10px ui-monospace, SFMono-Regular, Consolas, monospace";
      const shortName = String(d.name || `S${idx + 1}`).slice(0, 12);
      ctx.fillText(`S${idx + 1} ${shortName}`, 12, midY + 3);

      // Waveform path (±1.5 m/s², 3 s window).
      const points = Array.isArray(d.points) ? d.points : [];
      if (points.length === 0 || state === "disconnected") return;

      ctx.strokeStyle = style.color;
      ctx.lineWidth = this.eco ? 1.2 : 1.5;
      ctx.beginPath();
      let started = false;

      for (const p of points) {
        if (!p || !Number.isFinite(p.time) || !Number.isFinite(p.value)) continue;
        const x = plotX + plotW * (1 - (nowServerMs - p.time) / 3000);
        if (x < plotX) continue;
        if (x > plotX + plotW + 2) continue;
        const clamped = Math.max(-1.5, Math.min(1.5, p.value));
        const y = midY - clamped * ampScale;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (started) ctx.stroke();

      // Mark trigger points on trace.
      if (!this.eco) {
        ctx.fillStyle = "#d3ed91";
        for (const p of points) {
          if (!p?.trigger || !Number.isFinite(p.time)) continue;
          const x = plotX + plotW * (1 - (nowServerMs - p.time) / 3000);
          if (x < plotX || x > plotX + plotW) continue;
          const clamped = Math.max(-1.5, Math.min(1.5, p.value || 0));
          const y = midY - clamped * ampScale;
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });

    ctx.restore?.();
  }
}
