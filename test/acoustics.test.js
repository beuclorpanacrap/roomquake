import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SPEED_OF_SOUND,
  beepBeepDistance,
  combinePairwiseMatrices,
  detectChirpCorrelation,
  fitRelativeLayout2D,
  generateChirp,
  transformLayout,
} from "../lib/acoustics.js";
import {
  AcousticExperimentClient,
  FrameRingBuffer,
} from "../public/acoustics-client.js";

function makeRng(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randn(rng) {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function distanceBetween(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pairwiseDistanceMatrix(points) {
  return points.map((pi) => points.map((pj) => distanceBetween(pi, pj)));
}

test("generateChirp produces a Hann-windowed Float32Array linear FM chirp", () => {
  const sr = 48000;
  const chirp = generateChirp(sr, {
    f0: 2000,
    f1: 6000,
    durationSec: 0.08,
    gain: 0.35,
  });
  assert.ok(chirp instanceof Float32Array);
  assert.equal(chirp.length, 3840);
  assert.equal(chirp[0], 0);
  assert.ok(Math.abs(chirp[chirp.length - 1]) < 1e-6);

  let maxAbs = 0;
  for (let i = 0; i < chirp.length; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(chirp[i]));
  }
  assert.ok(maxAbs > 0.3 && maxAbs <= 0.3501);
});

test("generateChirp + detectChirpCorrelation recovers exact sample offset in additive noise", () => {
  const sr = 48000;
  const chirp = generateChirp(sr, {
    f0: 2000,
    f1: 6000,
    durationSec: 0.08,
    gain: 0.35,
  });
  const offset = 12345;
  const rng = makeRng(42);
  const samples = new Float32Array(sr);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.04 * randn(rng);
  }
  for (let i = 0; i < chirp.length; i++) {
    samples[offset + i] += 0.6 * chirp[i];
  }

  const det = detectChirpCorrelation(samples, chirp, { sampleRate: sr });
  assert.ok(det !== null);
  assert.ok(Math.abs(det.index - offset) < 0.25, `got ${det.index}`);
  assert.ok(det.snr > 15);
  assert.ok(det.peak > 0);
});

test("detectChirpCorrelation rejects pure noise and selects first direct arrival ahead of stronger echo", () => {
  const sr = 48000;
  const chirp = generateChirp(sr);
  const rng = makeRng(99);
  const noiseOnly = new Float32Array(24000);
  for (let i = 0; i < noiseOnly.length; i++) {
    noiseOnly[i] = 0.05 * randn(rng);
  }
  assert.equal(
    detectChirpCorrelation(noiseOnly, chirp, { sampleRate: sr, minSnr: 6.0 }),
    null,
  );

  // Direct path at 5000 (0.7x), stronger reflection 8 ms later at 5384 (1.0x).
  const multipath = new Float32Array(24000);
  for (let i = 0; i < multipath.length; i++) {
    multipath[i] = 0.01 * randn(rng);
  }
  const directIdx = 5000;
  const echoIdx = directIdx + Math.round(0.008 * sr);
  for (let i = 0; i < chirp.length; i++) {
    multipath[directIdx + i] += 0.7 * chirp[i];
    multipath[echoIdx + i] += 1.0 * chirp[i];
  }

  const det = detectChirpCorrelation(multipath, chirp, {
    sampleRate: sr,
    firstArrivalFrac: 0.55,
  });
  assert.ok(det !== null);
  assert.ok(
    Math.abs(det.index - directIdx) < 1.0,
    `expected ~${directIdx}, got ${det.index}`,
  );
});

test("beepBeepDistance cancels arbitrary device clock offsets and asymmetric audio latencies to < 0.5 mm", () => {
  const c = DEFAULT_SPEED_OF_SOUND;
  const trueDist = 0.943398; // e.g. sqrt(0.8^2 + 0.5^2)
  const selfDistM = 0.06;

  // True physical emission times
  const tEmitI = 10.0;
  const tEmitJ = 10.75;

  // Arbitrary clock offsets and asymmetric input/output latencies
  const clockOffsetI = 4.2; // +4.2 s
  const clockOffsetJ = -13.85; // -13.85 s
  const outLatI = 0.038; // 38 ms
  const outLatJ = 0.112; // 112 ms
  const inLatI = 0.067; // 67 ms
  const inLatJ = 0.019; // 19 ms

  const trueSpeakerI = tEmitI + outLatI;
  const trueSpeakerJ = tEmitJ + outLatJ;

  // Local recorded arrival timestamps on each device's audio clock
  const t_ii = trueSpeakerI + selfDistM / c + clockOffsetI + inLatI;
  const t_ji = trueSpeakerI + trueDist / c + clockOffsetJ + inLatJ;
  const t_jj = trueSpeakerJ + selfDistM / c + clockOffsetJ + inLatJ;
  const t_ij = trueSpeakerJ + trueDist / c + clockOffsetI + inLatI;

  const est = beepBeepDistance(t_ii, t_ij, t_ji, t_jj, {
    speedOfSound: c,
    selfDistM,
  });
  assert.ok(est !== null);
  assert.ok(
    Math.abs(est - trueDist) < 0.0005,
    `error ${(Math.abs(est - trueDist) * 1000).toFixed(4)} mm`,
  );

  assert.equal(beepBeepDistance(t_ii, NaN, t_ji, t_jj), null);
  assert.equal(beepBeepDistance(null, t_ij, t_ji, t_jj), null);
});

test("combinePairwiseMatrices takes element-wise median across rounds ignoring null and NaN", () => {
  const m1 = [
    [0, 0.81, null],
    [0.81, 0, 0.52],
    [null, 0.52, 0],
  ];
  const m2 = [
    [0, 0.79, 0.94],
    [0.79, 0, NaN],
    [0.94, NaN, 0],
  ];
  const m3 = [
    [0, 2.5, 0.96], // 2.5 m echo outlier in round 3
    [2.5, 0, 0.5],
    [0.96, 0.5, 0],
  ];

  const med = combinePairwiseMatrices([m1, m2, m3]);
  assert.ok(Math.abs(med[0][1] - 0.81) < 1e-12);
  assert.ok(Math.abs(med[0][2] - 0.95) < 1e-12);
  assert.ok(Math.abs(med[1][2] - 0.51) < 1e-12);
  assert.equal(med[0][0], 0);
});

test("fitRelativeLayout2D recovers 4-phone 0.80m x 0.50m tabletop rectangle within < 5 cm under +-3 cm noise", () => {
  const truePts = [
    [0, 0],
    [0.8, 0],
    [0.8, 0.5],
    [0, 0.5],
  ];
  const trueD = pairwiseDistanceMatrix(truePts);

  for (const seed of [7, 19, 101]) {
    const rng = makeRng(seed);
    const noisyD = Array.from({ length: 4 }, () => new Array(4).fill(0));
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const err = (rng() * 2 - 1) * 0.03; // uniform +-3 cm
        const val = Math.max(0.05, trueD[i][j] + err);
        noisyD[i][j] = noisyD[j][i] = val;
      }
    }

    const res = fitRelativeLayout2D(noisyD);
    assert.equal(res.confidence, "high");
    assert.equal(res.validPairs, 6);
    assert.equal(res.coords.length, 4);
    assert.ok(res.medianResidualCm <= 15);

    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const fitDist = distanceBetween(res.coords[i], res.coords[j]);
        const diff = Math.abs(fitDist - trueD[i][j]);
        assert.ok(
          diff < 0.05,
          `seed=${seed} pair (${i},${j}) error ${(diff * 100).toFixed(2)} cm`,
        );
      }
    }
  }
});

test("fitRelativeLayout2D handles degenerate squares, sparse matrices, and drops inconsistent distances to low confidence", () => {
  // Exact symmetric square (degenerate repeated eigenvalues)
  const squarePts = [
    [0, 0],
    [0.6, 0],
    [0.6, 0.6],
    [0, 0.6],
  ];
  const sqD = pairwiseDistanceMatrix(squarePts);
  const sqRes = fitRelativeLayout2D(sqD);
  assert.equal(sqRes.confidence, "high");
  assert.ok(sqRes.maxResidualCm < 1e-6);

  // Wildly inconsistent / noisy distances -> confidence === "low"
  const badD = [
    [0, 0.25, 1.9, 0.3],
    [0.25, 0, 0.25, 1.85],
    [1.9, 0.25, 0, 0.25],
    [0.3, 1.85, 0.25, 0],
  ];
  const badRes = fitRelativeLayout2D(badD);
  assert.equal(badRes.confidence, "low");
  assert.ok(badRes.medianResidualCm > 15);

  // Insufficient valid pairs -> confidence === "low"
  const sparseD = [
    [0, 0.8, null, null],
    [0.8, 0, 0.5, null],
    [null, 0.5, 0, 0.8],
    [null, null, 0.8, 0],
  ];
  const sparseRes = fitRelativeLayout2D(sparseD);
  assert.equal(sparseRes.confidence, "low");
  assert.equal(sparseRes.validPairs, 3);

  // Fewer than 3 devices -> confidence === "low"
  const twoRes = fitRelativeLayout2D([
    [0, 0.7],
    [0.7, 0],
  ]);
  assert.equal(twoRes.confidence, "low");
  assert.equal(twoRes.validPairs, 1);
});

test("transformLayout rotates and mirrors coordinates rigidly without distorting pairwise distances", () => {
  const pts = [
    [-0.4, -0.25],
    [0.4, -0.25],
    [0.4, 0.25],
    [-0.4, 0.25],
  ];
  const rotated = transformLayout(pts, { rotationDeg: 90, mirrorX: false });
  assert.ok(Math.abs(rotated[0][0] - 0.25) < 1e-9);
  assert.ok(Math.abs(rotated[0][1] - -0.4) < 1e-9);

  const mirrored = transformLayout(pts, { rotationDeg: 37, mirrorX: true });
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      assert.ok(
        Math.abs(
          distanceBetween(pts[i], pts[j]) -
            distanceBetween(mirrored[i], mirrored[j]),
        ) < 1e-12,
      );
    }
  }
});

test("AcousticExperimentClient finds chirps locally without streaming PCM and gates transient onset on opt-in flag", async () => {
  const sr = 48000;
  const chirp = generateChirp(sr);
  const transients = [];
  let nowMs = 10000;

  const client = new AcousticExperimentClient({
    ringSeconds: 4,
    liveTransientEnabled: false,
    onTransient: (ev) => transients.push(ev),
    now: () => nowMs,
  });

  // Ingest quiet background + chirp at frame 14400
  const buf = new Float32Array(sr);
  const rng = makeRng(55);
  for (let i = 0; i < buf.length; i++) buf[i] = 0.005 * randn(rng);
  const chirpFrame = 14400;
  for (let i = 0; i < chirp.length; i++) buf[chirpFrame + i] += chirp[i];

  // Feed in 2048-sample worklet chunks
  for (let off = 0; off < buf.length; off += 2048) {
    const chunk = buf.subarray(off, Math.min(buf.length, off + 2048));
    nowMs += (chunk.length / sr) * 1000;
    client.ingestChunk(off, chunk, sr);
  }

  // Must NOT emit transients while liveTransientEnabled === false
  assert.equal(transients.length, 0);

  // Must find local chirp and return ONLY { frame, snr, peak }
  const det = client.findLocalChirp(chirpFrame - 1200, 0.2, 0.4);
  assert.ok(det !== null);
  assert.deepEqual(Object.keys(det).sort(), ["frame", "peak", "snr"]);
  assert.ok(Math.abs(det.frame - chirpFrame) < 0.5);

  // Enable live transient onset analyzer and feed quiet baseline followed by a sharp knock
  client.setLiveTransientEnabled(true);
  const frameBase = sr;
  const knockSignal = new Float32Array(sr);
  for (let i = 0; i < knockSignal.length; i++) {
    knockSignal[i] = 0.002 * randn(rng);
  }
  const knockOffset = 9600; // 200 ms into second chunk
  for (let i = 0; i < 400; i++) {
    const env = Math.exp(-i / 60);
    knockSignal[knockOffset + i] += 0.65 * env * Math.sin(2 * Math.PI * 2200 * (i / sr));
  }

  for (let off = 0; off < knockSignal.length; off += 2048) {
    const chunk = knockSignal.subarray(
      off,
      Math.min(knockSignal.length, off + 2048),
    );
    nowMs += (chunk.length / sr) * 1000;
    client.ingestChunk(frameBase + off, chunk, sr);
  }

  assert.equal(transients.length, 1);
  assert.deepEqual(
    Object.keys(transients[0]).sort(),
    ["confidence", "peakDb", "t"],
  );
  assert.ok(transients[0].confidence >= 0.5 && transients[0].confidence <= 1);
  assert.ok(transients[0].peakDb > -20);
  assert.ok(Number.isFinite(transients[0].t));
});

test("AcousticExperimentClient startMic calls ctx.resume() before getUserMedia, sets audioSession, loads /capture-worklet.js, and stopMic cleans up", async () => {
  const calls = [];
  const track = {
    readyState: "live",
    stop() {
      calls.push("track.stop");
      this.readyState = "ended";
    },
  };
  const mockAudioSession = { type: "ambient" };

  class MockAudioContext {
    constructor(opts) {
      calls.push(["new AudioContext", opts]);
      this.sampleRate = 48000;
      this.state = "suspended";
      this.currentTime = 1.0;
      this.destination = { kind: "dest" };
      this.audioWorklet = {
        addModule: async (url) => {
          calls.push(["addModule", url]);
        },
      };
    }
    resume() {
      calls.push("ctx.resume");
      this.state = "running";
      return Promise.resolve();
    }
    close() {
      calls.push("ctx.close");
      this.state = "closed";
      return Promise.resolve();
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    createBuffer(channels, length, sr) {
      return {
        channels,
        length,
        sr,
        copyToChannel() {},
      };
    }
    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        start(when) {
          calls.push(["src.start", when]);
        },
      };
    }
  }

  class MockAudioWorkletNode {
    constructor(ctx, name) {
      calls.push(["new AudioWorkletNode", name]);
      this.port = {
        onmessage: null,
        postMessage(msg) {
          calls.push(["port.postMessage", msg]);
        },
      };
    }
    connect() {}
    disconnect() {}
  }

  const prevAC = globalThis.AudioContext;
  const prevWorkletNode = globalThis.AudioWorkletNode;
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );

  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    writable: true,
    value: MockAudioContext,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    writable: true,
    value: MockAudioWorkletNode,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      audioSession: mockAudioSession,
      mediaDevices: {
        getUserMedia: async (constraints) => {
          calls.push(["getUserMedia", constraints]);
          return {
            getTracks: () => [track],
            getAudioTracks: () => [track],
          };
        },
      },
    },
  });

  try {
    const client = new AcousticExperimentClient();
    await client.startMic();

    const resumeIdx = calls.indexOf("ctx.resume");
    const gumIdx = calls.findIndex((c) => Array.isArray(c) && c[0] === "getUserMedia");
    assert.ok(resumeIdx >= 0 && gumIdx > resumeIdx);
    assert.equal(mockAudioSession.type, "play-and-record");
    assert.deepEqual(calls[gumIdx][1], {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    assert.ok(
      calls.some(
        (c) => Array.isArray(c) && c[0] === "addModule" && c[1] === "/capture-worklet.js",
      ),
    );
    assert.ok(
      calls.some(
        (c) => Array.isArray(c) && c[0] === "new AudioWorkletNode" && c[1] === "rq-capture",
      ),
    );

    const scheduledFrame = client.playCalibrationChirp({
      f0: 2000,
      f1: 6000,
      durationSec: 0.08,
    });
    assert.equal(scheduledFrame, Math.round(1.05 * 48000));

    await client.stopMic();
    assert.ok(calls.includes("track.stop"));
    assert.ok(calls.includes("ctx.close"));
    assert.equal(client.running, false);
  } finally {
    if (prevAC === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = prevAC;

    if (prevWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = prevWorkletNode;

    if (prevNavigatorDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavigatorDesc);
    }
  }
});

test("FrameRingBuffer handles gaps and overlaps truthfully", () => {
  const ring = new FrameRingBuffer(100);
  ring.write(10, new Float32Array([1, 2, 3, 4]));
  // Gap from 14 to 20
  ring.write(20, new Float32Array([5, 6, 7]));
  assert.equal(ring.gaps.length, 1);
  assert.equal(ring.gaps[0].at, 14);
  assert.equal(ring.gaps[0].missing, 6);

  const { samples, lo, hi } = ring.read(10, 23);
  assert.equal(lo, 10);
  assert.equal(hi, 23);
  assert.deepEqual(Array.from(samples), [1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 5, 6, 7]);
});

test("end-to-end simulated 4-phone chirp ranging + BeepBeep + MDS recovers 0.80m x 0.50m geometry", () => {
  const sr = 48000;
  const c = DEFAULT_SPEED_OF_SOUND;
  const selfDistM = 0.06;
  const pts = [
    [0, 0],
    [0.8, 0],
    [0.8, 0.5],
    [0, 0.5],
  ];
  const trueD = pairwiseDistanceMatrix(pts);
  const template = generateChirp(sr);
  const clockOffsets = [4.2, -3.1, 12.7, -0.85];
  const inLatencies = [0.038, 0.095, 0.021, 0.064];
  const outLatencies = [0.112, 0.044, 0.087, 0.031];
  const rng = makeRng(2026);

  // Add fractional-delay chirp into buffer using linear interpolation.
  const addFractionalChirp = (buf, fracStart, amp) => {
    const i0 = Math.floor(fracStart);
    const frac = fracStart - i0;
    for (let k = 0; k < template.length; k++) {
      const idx = i0 + k;
      const v0 = template[k];
      const v1 = k > 0 ? template[k - 1] : 0;
      const sample = (1 - frac) * v0 + frac * v1;
      if (idx >= 0 && idx < buf.length) buf[idx] += amp * sample;
    }
  };

  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const buffers = Array.from({ length: 4 }, () => {
      const b = new Float32Array(2 * sr);
      for (let k = 0; k < b.length; k++) b[k] = 0.015 * randn(rng);
      return b;
    });

    const emitPhys = [0.25, 0.65, 1.05, 1.45];
    const arrivals = Array.from({ length: 4 }, () => new Array(4).fill(null));

    for (let emitter = 0; emitter < 4; emitter++) {
      const speakerPhys = emitPhys[emitter] + outLatencies[emitter];
      for (let receiver = 0; receiver < 4; receiver++) {
        const propDist = emitter === receiver ? selfDistM : trueD[emitter][receiver];
        const arrivalPhys = speakerPhys + propDist / c;
        // Record relative to each receiver's local audio clock window
        const localTime = arrivalPhys + inLatencies[receiver] + clockOffsets[receiver];
        const windowStartLocal = clockOffsets[receiver];
        const sampleOffset = (localTime - windowStartLocal) * sr;
        const amp = emitter === receiver ? 0.9 : 0.4;
        addFractionalChirp(buffers[receiver], sampleOffset, amp);
      }
    }

    for (let receiver = 0; receiver < 4; receiver++) {
      for (let emitter = 0; emitter < 4; emitter++) {
        const approxSample = Math.round(
          (emitPhys[emitter] + outLatencies[emitter] + inLatencies[receiver]) * sr,
        );
        const lo = Math.max(0, approxSample - Math.round(0.1 * sr));
        const hi = Math.min(buffers[receiver].length, approxSample + Math.round(0.2 * sr));
        const det = detectChirpCorrelation(
          buffers[receiver].subarray(lo, hi),
          template,
          { sampleRate: sr },
        );
        assert.ok(det !== null);
        // Convert detected sample offset back into receiver's local clock (seconds)
        arrivals[receiver][emitter] = (lo + det.index) / sr + clockOffsets[receiver];
      }
    }

    const roundD = Array.from({ length: 4 }, () => new Array(4).fill(0));
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const d = beepBeepDistance(
          arrivals[i][i],
          arrivals[i][j],
          arrivals[j][i],
          arrivals[j][j],
          { speedOfSound: c, selfDistM },
        );
        roundD[i][j] = roundD[j][i] = d;
      }
    }
    rounds.push(roundD);
  }

  const combined = combinePairwiseMatrices(rounds);
  const layout = fitRelativeLayout2D(combined);
  assert.equal(layout.confidence, "high");
  assert.equal(layout.validPairs, 6);
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const recovered = distanceBetween(layout.coords[i], layout.coords[j]);
      assert.ok(
        Math.abs(recovered - trueD[i][j]) < 0.02,
        `pair (${i},${j}) error ${Math.abs(recovered - trueD[i][j])}`,
      );
    }
  }
});
