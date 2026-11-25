// Pure-ESM acoustic ranging and 2D relative geometry helpers (Node + Browser).
// BeepBeep two-way ranging, chirp envelope detection, and MDS layout concepts
// are inspired by beep-locator (Apache-2.0).

export const DEFAULT_SPEED_OF_SOUND = 343;

/**
 * Generate a Hann-windowed linear FM chirp as a Float32Array.
 */
export function generateChirp(
  sampleRate,
  { f0 = 2000, f1 = 6000, durationSec = 0.08, gain = 0.35 } = {},
) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive finite number");
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return new Float32Array(0);
  }
  const n = Math.max(1, Math.round(durationSec * sampleRate));
  const out = new Float32Array(n);
  const k = (f1 - f0) / durationSec;
  const invDenom = n > 1 ? 1 / (n - 1) : 0;

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    const hann = n > 1 ? 0.5 * (1 - Math.cos(2 * Math.PI * i * invDenom)) : 1;
    out[i] = gain * hann * Math.sin(phase);
  }
  return out;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function fftInPlace(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (sign * 2 * Math.PI) / len;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const vRe = re[b] * wRe - im[b] * wIm;
        const vIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - vRe;
        im[b] = im[a] - vIm;
        re[a] += vRe;
        im[a] += vIm;
        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

function correlateValid(x, template) {
  const nx = x.length;
  const nt = template.length;
  if (nx < nt || nt === 0) return new Float64Array(0);
  const m = nx - nt + 1;
  const nfft = nextPow2(nx + nt);

  const reX = new Float64Array(nfft);
  const imX = new Float64Array(nfft);
  const reT = new Float64Array(nfft);
  const imT = new Float64Array(nfft);

  for (let i = 0; i < nx; i++) reX[i] = x[i];
  for (let i = 0; i < nt; i++) reT[i] = template[i];

  fftInPlace(reX, imX, false);
  fftInPlace(reT, imT, false);

  // Multiply X * conj(T) to compute valid linear cross-correlation.
  for (let k = 0; k < nfft; k++) {
    const a = reX[k];
    const b = imX[k];
    const c = reT[k];
    const d = imT[k];
    reX[k] = a * c + b * d;
    imX[k] = b * c - a * d;
  }

  fftInPlace(reX, imX, true);
  return reX.subarray(0, m);
}

function analyticEnvelope(signal) {
  const len = signal.length;
  if (len === 0) return new Float64Array(0);
  const nfft = nextPow2(len);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  re.set(signal);

  fftInPlace(re, im, false);
  const half = nfft >> 1;
  for (let k = 1; k < half; k++) {
    re[k] *= 2;
    im[k] *= 2;
  }
  for (let k = half + 1; k < nfft; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  fftInPlace(re, im, true);

  const env = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    env[i] = Math.hypot(re[i], im[i]);
  }
  return env;
}

function medianFloat64(arr) {
  if (arr.length === 0) return 0;
  const sorted = new Float64Array(arr).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function parabolicPeak(y, i) {
  if (i <= 0 || i >= y.length - 1) return i;
  const a = y[i - 1];
  const b = y[i];
  const c = y[i + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return i;
  const delta = Math.max(-1, Math.min(1, (0.5 * (a - c)) / denom));
  return i + delta;
}

const sidelobeCache = new Map();

function getSidelobeProfile(template, maxLag = 120) {
  const nt = template.length;
  const lagLimit = Math.min(maxLag, nt - 1);
  if (lagLimit < 1) return new Float64Array(0);

  let absSum = 0;
  for (let i = 0; i < nt; i++) absSum += Math.abs(template[i]);
  const key = `${nt}:${lagLimit}:${template[nt >> 1]}:${absSum}`;
  const cached = sidelobeCache.get(key);
  if (cached) return cached;

  const padded = new Float64Array(nt + 2 * lagLimit);
  for (let i = 0; i < nt; i++) padded[lagLimit + i] = template[i];
  const env = analyticEnvelope(correlateValid(padded, template));
  const centerPeak = env[lagLimit];
  if (centerPeak <= 1e-12) return new Float64Array(lagLimit);

  const raw = new Float64Array(lagLimit);
  for (let k = 0; k < lagLimit; k++) {
    raw[k] = Math.max(env[lagLimit - 1 - k], env[lagLimit + 1 + k]) / centerPeak;
  }

  // Zero out the main lobe up to its first local trough so real earlier arrivals
  // outside the main lobe are evaluated against actual sidelobe levels.
  let mainEnd = 0;
  for (let k = 0; k < lagLimit - 1; k++) {
    if (raw[k + 1] > raw[k]) {
      mainEnd = k;
      break;
    }
  }
  for (let k = 0; k < mainEnd; k++) raw[k] = 0;

  const prof = new Float64Array(lagLimit);
  for (let k = 0; k < lagLimit; k++) {
    let m = 0;
    const lo = Math.max(0, k - 3);
    const hi = Math.min(lagLimit - 1, k + 3);
    for (let j = lo; j <= hi; j++) {
      if (raw[j] > m) m = raw[j];
    }
    prof[k] = m;
  }

  if (sidelobeCache.size > 32) sidelobeCache.clear();
  sidelobeCache.set(key, prof);
  return prof;
}

/**
 * Matched-filter cross-correlation envelope detector with first-arrival logic.
 * Returns { index, snr, peak } (fractional sample index) or null.
 */
export function detectChirpCorrelation(
  samples,
  template,
  {
    sampleRate = 48000,
    minSnr = 6.0,
    firstArrivalFrac = 0.55,
    maxEarlySec = 0.025,
  } = {},
) {
  if (
    !samples ||
    !template ||
    template.length === 0 ||
    samples.length < template.length
  ) {
    return null;
  }

  const corr = correlateValid(samples, template);
  if (corr.length < 4) return null;

  const env = analyticEnvelope(corr);
  let p = 0;
  let peak = env[0];
  for (let i = 1; i < env.length; i++) {
    if (env[i] > peak) {
      peak = env[i];
      p = i;
    }
  }

  if (!Number.isFinite(peak) || peak <= 1e-12) return null;

  const noise = medianFloat64(env) + 1e-12;
  const snr = peak / noise;
  if (snr < minSnr) return null;

  // Earliest local maximum within maxEarlySec before the global peak that clears
  // firstArrivalFrac and exceeds correlation sidelobes of any later stronger peak.
  const start = Math.max(1, p - Math.round(maxEarlySec * sampleRate));
  const thresh = firstArrivalFrac * peak;
  const side = getSidelobeProfile(template);
  let first = p;

  for (let i = start; i < p; i++) {
    const isPeak =
      (env[i] > env[i - 1] && env[i] >= env[i + 1]) ||
      (env[i] >= env[i - 1] && env[i] > env[i + 1]);
    if (!isPeak || env[i] < thresh) continue;

    const limit = Math.min(side.length, env.length - i - 1);
    let sidelobeBound = 0;
    for (let k = 0; k < limit; k++) {
      const bound = env[i + 1 + k] * side[k];
      if (bound > sidelobeBound) sidelobeBound = bound;
    }
    if (env[i] > 2.0 * sidelobeBound) {
      first = i;
      break;
    }
  }

  const index = parabolicPeak(env, first);
  return { index, snr, peak };
}

/**
 * BeepBeep two-way acoustic ranging between devices i and j.
 * Timestamps are in seconds on each device's local audio clock:
 *   t_ii: i hears i, t_ij: i hears j, t_ji: j hears i, t_jj: j hears j.
 * Cancels arbitrary device clock offsets and output/input audio I/O latencies.
 */
export function beepBeepDistance(
  t_ii,
  t_ij,
  t_ji,
  t_jj,
  { speedOfSound = DEFAULT_SPEED_OF_SOUND, selfDistM = 0.06 } = {},
) {
  if (
    !Number.isFinite(t_ii) ||
    !Number.isFinite(t_ij) ||
    !Number.isFinite(t_ji) ||
    !Number.isFinite(t_jj) ||
    !Number.isFinite(speedOfSound) ||
    speedOfSound <= 0 ||
    !Number.isFinite(selfDistM)
  ) {
    return null;
  }
  return 0.5 * speedOfSound * (t_ij - t_ii + (t_ji - t_jj)) + selfDistM;
}

/**
 * Element-wise median across multiple pairwise distance matrices, ignoring null/NaN.
 */
export function combinePairwiseMatrices(matrices) {
  if (!Array.isArray(matrices) || matrices.length === 0) return [];
  const n = Math.max(...matrices.map((m) => (Array.isArray(m) ? m.length : 0)));
  if (n === 0) return [];

  const out = Array.from({ length: n }, () => new Array(n).fill(null));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const vals = [];
      for (const m of matrices) {
        const v = m?.[i]?.[j];
        if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
      }
      if (vals.length === 0) {
        out[i][j] = i === j ? 0 : null;
      } else {
        vals.sort((a, b) => a - b);
        const mid = vals.length >> 1;
        out[i][j] =
          vals.length % 2 === 1 ? vals[mid] : 0.5 * (vals[mid - 1] + vals[mid]);
      }
    }
  }
  return out;
}

function fillMissingDistances(obs, n) {
  const G = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) G[i * n + j] = 0;
      else {
        const v = obs[i * n + j];
        G[i * n + j] = Number.isFinite(v) ? v : Infinity;
      }
    }
  }

  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const dik = G[i * n + k];
      if (!Number.isFinite(dik)) continue;
      for (let j = 0; j < n; j++) {
        const alt = dik + G[k * n + j];
        if (alt < G[i * n + j]) G[i * n + j] = alt;
      }
    }
  }

  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = obs[i * n + j];
      if (Number.isFinite(v) && v > 0) {
        sum += v;
        count++;
      }
    }
  }
  const fallback = count > 0 ? sum / count : 1.0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) G[i * n + j] = 0;
      else if (Number.isFinite(obs[i * n + j])) G[i * n + j] = obs[i * n + j];
      else if (!Number.isFinite(G[i * n + j])) G[i * n + j] = fallback;
    }
  }
  return G;
}

function dotVec(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function normVec(a) {
  return Math.sqrt(dotVec(a, a));
}

function matVec(M, n, v) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const row = i * n;
    for (let j = 0; j < n; j++) s += M[row + j] * v[j];
    out[i] = s;
  }
  return out;
}

function orthogonalizeAgainst(v, basis) {
  for (const b of basis) {
    const proj = dotVec(v, b);
    for (let i = 0; i < v.length; i++) v[i] -= proj * b[i];
  }
}

function initOrthogonalCandidate(n, basis, seedOffset) {
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    v[i] = Math.cos(1.37 * i + seedOffset) + 0.29 * ((i + 1) / n);
  }
  orthogonalizeAgainst(v, basis);
  let len = normVec(v);
  if (len > 1e-10) {
    for (let i = 0; i < n; i++) v[i] /= len;
    return v;
  }

  for (let k = 0; k < n; k++) {
    v.fill(0);
    v[k] = 1;
    orthogonalizeAgainst(v, basis);
    len = normVec(v);
    if (len > 1e-10) {
      for (let i = 0; i < n; i++) v[i] /= len;
      return v;
    }
  }
  return v;
}

function powerTopEigenpair(B, n, shift, orthBasis, seedOffset) {
  let v = initOrthogonalCandidate(n, orthBasis, seedOffset);
  if (normVec(v) <= 1e-12) return { vec: v, val: 0 };

  for (let iter = 0; iter < 800; iter++) {
    const w = matVec(B, n, v);
    for (let i = 0; i < n; i++) w[i] += shift * v[i];
    orthogonalizeAgainst(w, orthBasis);
    const wNorm = normVec(w);
    if (wNorm <= 1e-14) break;

    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      w[i] /= wNorm;
      const diff = Math.abs(w[i] - v[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
    v = w;
    if (maxDiff < 1e-11) break;
  }

  for (let i = 0; i < n; i++) {
    if (Math.abs(v[i]) > 1e-9) {
      if (v[i] < 0) for (let j = 0; j < n; j++) v[j] = -v[j];
      break;
    }
  }
  const bv = matVec(B, n, v);
  return { vec: v, val: dotVec(v, bv) };
}

function refineObservedStress(coords, obs, n, iters = 120) {
  // Lightweight gradient refinement used only when some pairs are missing,
  // preventing Floyd-Warshall upper-bound fills from stretching missing diagonals.
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = obs[i * n + j];
      if (Number.isFinite(d)) pairs.push([i, j, d]);
    }
  }
  if (pairs.length === 0) return coords;

  let cur = coords.map(([x, y]) => [x, y]);
  const stressOf = (pts) => {
    let e = 0;
    for (const [i, j, d] of pairs) {
      const diff = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) - d;
      e += 0.5 * diff * diff;
    }
    return e;
  };

  let curStress = stressOf(cur);
  let step = 0.25;
  for (let iter = 0; iter < iters && step > 1e-6; iter++) {
    const grad = Array.from({ length: n }, () => [0, 0]);
    for (const [i, j, d] of pairs) {
      const dx = cur[i][0] - cur[j][0];
      const dy = cur[i][1] - cur[j][1];
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-9) continue;
      const scale = (dist - d) / dist;
      grad[i][0] += scale * dx;
      grad[i][1] += scale * dy;
      grad[j][0] -= scale * dx;
      grad[j][1] -= scale * dy;
    }

    const next = cur.map(([x, y], idx) => [
      x - step * grad[idx][0],
      y - step * grad[idx][1],
    ]);
    const nextStress = stressOf(next);
    if (nextStress <= curStress) {
      if (Math.abs(curStress - nextStress) < 1e-11) {
        cur = next;
        break;
      }
      cur = next;
      curStress = nextStress;
      step = Math.min(0.5, step * 1.15);
    } else {
      step *= 0.5;
    }
  }
  return cur;
}

/**
 * Fit 2D relative coordinates from a pairwise distance matrix via Classical MDS
 * (double-centering B = -0.5 * J * D^2 * J and power-iteration top-2 eigenpairs).
 */
export function fitRelativeLayout2D(distanceMatrix) {
  const n = Array.isArray(distanceMatrix) ? distanceMatrix.length : 0;
  if (n === 0) {
    return {
      coords: [],
      medianResidualCm: 0,
      maxResidualCm: 0,
      confidence: "low",
      validPairs: 0,
    };
  }
  if (n === 1) {
    return {
      coords: [[0, 0]],
      medianResidualCm: 0,
      maxResidualCm: 0,
      confidence: "low",
      validPairs: 0,
    };
  }
  if (n === 2) {
    const v1 = distanceMatrix[0]?.[1];
    const v2 = distanceMatrix[1]?.[0];
    const ok1 = typeof v1 === "number" && Number.isFinite(v1) && v1 >= 0;
    const ok2 = typeof v2 === "number" && Number.isFinite(v2) && v2 >= 0;
    const hasPair = ok1 || ok2;
    const d = ok1 && ok2 ? 0.5 * (v1 + v2) : ok1 ? v1 : ok2 ? v2 : 0;
    return {
      coords: [
        [-0.5 * d, 0],
        [0.5 * d, 0],
      ],
      medianResidualCm: 0,
      maxResidualCm: 0,
      confidence: "low",
      validPairs: hasPair ? 1 : 0,
    };
  }

  const obs = new Float64Array(n * n).fill(NaN);
  const deg = new Int32Array(n);
  let validPairs = 0;
  for (let i = 0; i < n; i++) {
    obs[i * n + i] = 0;
    for (let j = i + 1; j < n; j++) {
      const v1 = distanceMatrix[i]?.[j];
      const v2 = distanceMatrix[j]?.[i];
      const ok1 = typeof v1 === "number" && Number.isFinite(v1) && v1 >= 0;
      const ok2 = typeof v2 === "number" && Number.isFinite(v2) && v2 >= 0;
      if (ok1 || ok2) {
        const d = ok1 && ok2 ? 0.5 * (v1 + v2) : ok1 ? v1 : v2;
        obs[i * n + j] = d;
        obs[j * n + i] = d;
        deg[i]++;
        deg[j]++;
        validPairs++;
      }
    }
  }

  // Verify graph connectivity across valid pairwise links.
  const visited = new Uint8Array(n);
  const queue = [0];
  visited[0] = 1;
  let reached = 0;
  while (queue.length > 0) {
    const u = queue.shift();
    reached++;
    for (let v = 0; v < n; v++) {
      if (!visited[v] && Number.isFinite(obs[u * n + v]) && u !== v) {
        visited[v] = 1;
        queue.push(v);
      }
    }
  }
  const connected = reached === n;
  const minDeg = Math.min(...deg);

  const totalPairs = (n * (n - 1)) / 2;
  const D =
    validPairs === totalPairs ? obs : fillMissingDistances(obs, n);

  // Double-centering: B = -0.5 * J * D^2 * J.
  const D2 = new Float64Array(n * n);
  const rowMean = new Float64Array(n);
  let grandMean = 0;
  for (let i = 0; i < n; i++) {
    let rSum = 0;
    for (let j = 0; j < n; j++) {
      const d = D[i * n + j];
      const d2 = d * d;
      D2[i * n + j] = d2;
      rSum += d2;
    }
    rowMean[i] = rSum / n;
    grandMean += rowMean[i];
  }
  grandMean /= n;

  const B = new Float64Array(n * n);
  let minGershgorin = Infinity;
  for (let i = 0; i < n; i++) {
    let offSum = 0;
    for (let j = 0; j < n; j++) {
      const val =
        -0.5 * (D2[i * n + j] - rowMean[i] - rowMean[j] + grandMean);
      B[i * n + j] = val;
      if (i !== j) offSum += Math.abs(val);
    }
    const lower = B[i * n + i] - offSum;
    if (lower < minGershgorin) minGershgorin = lower;
  }

  // Shift spectrum so B + shift * I is strictly positive definite, guaranteeing
  // power iteration selects the largest algebraic (most positive) eigenvalues.
  const shift = (minGershgorin < 0 ? -minGershgorin : 0) + 1e-6;
  const u0 = new Float64Array(n).fill(1 / Math.sqrt(n));

  const e1 = powerTopEigenpair(B, n, shift, [u0], 0.37);
  const e2 = powerTopEigenpair(B, n, shift, [u0, e1.vec], 1.91);

  let v1 = e1.vec;
  let v2 = e2.vec;
  let lam1 = e1.val;
  let lam2 = e2.val;

  // 2x2 Rayleigh-Ritz diagonalization separates near-degenerate eigenpairs.
  const bv1 = matVec(B, n, v1);
  const bv2 = matVec(B, n, v2);
  const h00 = dotVec(v1, bv1);
  const h11 = dotVec(v2, bv2);
  const h01 = dotVec(v1, bv2);
  if (Math.abs(h01) > 1e-12) {
    const theta = 0.5 * Math.atan2(2 * h01, h00 - h11);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const r1 = new Float64Array(n);
    const r2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      r1[i] = c * v1[i] + s * v2[i];
      r2[i] = -s * v1[i] + c * v2[i];
    }
    v1 = r1;
    v2 = r2;
    lam1 = dotVec(v1, matVec(B, n, v1));
    lam2 = dotVec(v2, matVec(B, n, v2));
  }

  if (lam2 > lam1) {
    [v1, v2] = [v2, v1];
    [lam1, lam2] = [lam2, lam1];
  }

  const s1 = Math.sqrt(Math.max(0, lam1));
  const s2 = Math.sqrt(Math.max(0, lam2));
  let coords = Array.from({ length: n }, (_, i) => [v1[i] * s1, v2[i] * s2]);

  if (validPairs < totalPairs && validPairs >= 2 * n - 3 && connected) {
    coords = refineObservedStress(coords, obs, n);
  }

  const residualsCm = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const meas = obs[i * n + j];
      if (!Number.isFinite(meas)) continue;
      const fit = Math.hypot(
        coords[i][0] - coords[j][0],
        coords[i][1] - coords[j][1],
      );
      residualsCm.push(Math.abs(fit - meas) * 100);
    }
  }

  let medianResidualCm = 0;
  let maxResidualCm = 0;
  if (residualsCm.length > 0) {
    residualsCm.sort((a, b) => a - b);
    const mid = residualsCm.length >> 1;
    medianResidualCm =
      residualsCm.length % 2 === 1
        ? residualsCm[mid]
        : 0.5 * (residualsCm[mid - 1] + residualsCm[mid]);
    maxResidualCm = residualsCm[residualsCm.length - 1];
  }

  const minRequiredPairs = Math.max(2 * n - 3, Math.ceil(0.7 * totalPairs));
  const sufficientPairs =
    validPairs >= minRequiredPairs && minDeg >= 2 && connected;
  const confidence =
    n >= 3 && sufficientPairs && medianResidualCm <= 15 ? "high" : "low";

  return {
    coords,
    medianResidualCm,
    maxResidualCm,
    confidence,
    validPairs,
  };
}

/**
 * Apply rigid 2D rotation and optional horizontal reflection for host alignment
 * (acknowledging global rotation and mirror ambiguity of relative ranging).
 */
export function transformLayout(
  coords,
  { rotationDeg = 0, mirrorX = false } = {},
) {
  if (!Array.isArray(coords)) return [];
  const rad = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return coords.map((pt) => {
    const x = mirrorX ? -pt[0] : pt[0];
    const y = pt[1];
    return [x * c - y * s, x * s + y * c];
  });
}
