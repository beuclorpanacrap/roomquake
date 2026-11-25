/**
 * Pure accelerometer flat/still placement state machine for phone onboarding.
 * Works identically in Node 24 and modern browsers with no DOM dependencies.
 */

function stdDev(samples, fromIndex = 0) {
  const count = samples.length - fromIndex;
  if (count <= 0) return Infinity;
  let sum = 0;
  for (let i = fromIndex; i < samples.length; i++) sum += samples[i].mag;
  const mean = sum / count;
  let sq = 0;
  for (let i = fromIndex; i < samples.length; i++) {
    const d = samples[i].mag - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / count);
}

export function createFlatStillTracker({
  flatCosMin = 0.94,
  stillStdMax = 0.08,
  calibrateMs = 1000,
  moveHoldMs = 500,
  tiltDropMs = 350,
} = {}) {
  const windowMs = 1000;
  const recentMs = Math.max(80, Math.min(250, moveHoldMs * 0.5));
  let state = "place_flat";
  let window = [];
  let calibratingSince = null;
  let tiltDropStart = null;
  let moveStart = null;
  let lastT = null;
  let lastTiltDeg = 90;
  let lastStillStd = Infinity;

  function progressAt(t) {
    if (state === "ready") return 1;
    if (state === "calibrating" && calibratingSince !== null) {
      if (calibrateMs <= 0) return 1;
      return Math.max(0, Math.min(1, (t - calibratingSince) / calibrateMs));
    }
    return 0;
  }

  function reset() {
    state = "place_flat";
    window = [];
    calibratingSince = null;
    tiltDropStart = null;
    moveStart = null;
    lastT = null;
    lastTiltDeg = 90;
    lastStillStd = Infinity;
  }

  function push(sample) {
    if (
      !sample ||
      !Number.isFinite(sample.x) ||
      !Number.isFinite(sample.y) ||
      !Number.isFinite(sample.z) ||
      !Number.isFinite(sample.t)
    ) {
      return {
        state,
        changed: false,
        tiltDeg: lastTiltDeg,
        stillStd: lastStillStd,
        progress: progressAt(lastT ?? 0),
      };
    }

    const { x, y, z, t } = sample;
    if (lastT !== null && t < lastT) {
      return {
        state,
        changed: false,
        tiltDeg: lastTiltDeg,
        stillStd: lastStillStd,
        progress: progressAt(lastT),
      };
    }
    lastT = t;

    const mag = Math.hypot(x, y, z);
    const cosTheta = mag > 0.1 ? Math.abs(z) / mag : 0;
    const tiltDeg = (Math.acos(Math.min(1, cosTheta)) * 180) / Math.PI;
    window.push({ t, mag });
    while (window.length && t - window[0].t > windowMs) window.shift();

    const span = window.length >= 2 ? window[window.length - 1].t - window[0].t : 0;
    const stillStd =
      window.length < 8 || span < 250 ? Infinity : stdDev(window, 0);

    lastTiltDeg = tiltDeg;
    lastStillStd = stillStd;

    const prevState = state;
    const isFlatAndStill = cosTheta >= flatCosMin && stillStd <= stillStdMax;

    if (state === "place_flat" || state === "moved") {
      if (isFlatAndStill) {
        state = "calibrating";
        calibratingSince = t;
        if (t - calibratingSince >= calibrateMs) {
          state = "ready";
          tiltDropStart = null;
          moveStart = null;
        }
      }
    } else if (state === "calibrating") {
      if (isFlatAndStill) {
        if (t - calibratingSince >= calibrateMs) {
          state = "ready";
          tiltDropStart = null;
          moveStart = null;
        }
      } else {
        state = "place_flat";
        calibratingSince = null;
      }
    } else if (state === "ready") {
      if (cosTheta < 0.9) tiltDropStart ??= t;
      else tiltDropStart = null;

      // Check a short recent sub-window alongside the 1 s window so brief tap
      // impulses (< 250 ms) do not keep moveStart armed while aging out.
      let recentIdx = window.length - 1;
      while (recentIdx > 0 && t - window[recentIdx - 1].t <= recentMs) {
        recentIdx--;
      }
      const recentCount = window.length - recentIdx;
      const recentStd = recentCount >= 2 ? stdDev(window, recentIdx) : stillStd;

      if (stillStd > 0.45 && recentStd > 0.45) moveStart ??= t;
      else moveStart = null;

      if (
        (tiltDropStart !== null && t - tiltDropStart > tiltDropMs) ||
        (moveStart !== null && t - moveStart > moveHoldMs)
      ) {
        state = "moved";
        calibratingSince = null;
        tiltDropStart = null;
        moveStart = null;
      }
    }

    return {
      state,
      changed: state !== prevState,
      tiltDeg,
      stillStd,
      progress: progressAt(t),
    };
  }

  return { push, reset };
}
