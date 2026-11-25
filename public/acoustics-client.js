// Strictly opt-in browser acoustic calibration & on-device transient analyzer.
// Local chirp correlation returns only compact { frame, snr, peak } metadata,
// and live transient detection emits only { t, confidence, peakDb } without
// ever streaming raw microphone PCM audio.
// AudioContext ring-buffer & iOS play-and-record flow inspired by beep-locator (Apache-2.0).

import { detectChirpCorrelation, generateChirp } from "../lib/acoustics.js";

/**
 * Rolling audio sample buffer indexed by AudioContext sample frame.
 */
export class FrameRingBuffer {
  constructor(capacitySamples) {
    this.cap = Math.max(1, Math.floor(capacitySamples));
    this.buf = new Float32Array(this.cap);
    this.start = 0;
    this.end = 0;
    this.started = false;
    this.gaps = [];
  }

  _put(frame, data) {
    let off = 0;
    while (off < data.length) {
      const pos = (((frame + off) % this.cap) + this.cap) % this.cap;
      const n = Math.min(data.length - off, this.cap - pos);
      this.buf.set(data.subarray(off, off + n), pos);
      off += n;
    }
  }

  write(frame, samples) {
    if (!samples || samples.length === 0) return;
    let f = Math.floor(frame);
    let data =
      samples instanceof Float32Array ? samples : new Float32Array(samples);

    if (!this.started) {
      this.started = true;
      this.start = f;
      this.end = f;
    }

    if (f > this.end) {
      const missing = f - this.end;
      this.gaps.push({ at: this.end, missing, t: Date.now() });
      if (this.gaps.length > 200) this.gaps.shift();
      const zeroFill = Math.min(missing, this.cap);
      this._put(f - zeroFill, new Float32Array(zeroFill));
    } else if (f < this.end) {
      const overlap = this.end - f;
      if (overlap >= data.length) return;
      data = data.subarray(overlap);
      f = this.end;
    }

    if (data.length > this.cap) {
      const trim = data.length - this.cap;
      f += trim;
      data = data.subarray(trim);
    }

    this._put(f, data);
    this.end = f + data.length;
    this.start = Math.max(this.start, this.end - this.cap);
  }

  read(fromFrame, toFrame) {
    const a = Math.floor(fromFrame);
    const b = Math.floor(toFrame);
    const out = new Float32Array(Math.max(0, b - a));
    if (!this.started || b <= a) return { samples: out, lo: a, hi: a };

    const lo = Math.max(a, this.start);
    const hi = Math.min(b, this.end);
    let f = lo;
    while (f < hi) {
      const pos = (((f % this.cap) + this.cap) % this.cap);
      const n = Math.min(hi - f, this.cap - pos);
      out.set(this.buf.subarray(pos, pos + n), f - a);
      f += n;
    }
    return { samples: out, lo, hi };
  }
}

function createHighpassBiquad(cutoffHz, sampleRate) {
  const fc = Math.max(20, Math.min(cutoffHz, sampleRate * 0.45));
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cw) / 2 / a0,
    b1: -(1 + cw) / a0,
    b2: (1 + cw) / 2 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

/**
 * Opt-in client managing microphone capture, local chirp playback/correlation,
 * and optional on-device transient onset detection.
 */
export class AcousticExperimentClient {
  constructor({
    ringSeconds = 10,
    workletUrl = "/capture-worklet.js",
    liveTransientEnabled = false,
    onTransient = null,
    transientThresholdDb = 14,
    transientHighpassHz = 800,
    transientRefractoryMs = 500,
    transientMinRms = 0.004,
    now = () => Date.now(),
  } = {}) {
    this.ringSeconds = ringSeconds;
    this.workletUrl = workletUrl;
    this.liveTransientEnabled = Boolean(liveTransientEnabled);
    this.onTransient = typeof onTransient === "function" ? onTransient : null;
    this.transientThresholdDb = transientThresholdDb;
    this.transientHighpassHz = transientHighpassHz;
    this.transientRefractoryMs = transientRefractoryMs;
    this.transientMinRms = transientMinRms;
    this._now = now;

    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.workletNode = null;
    this.silentSink = null;
    this.outputGain = null;
    this.sampleRate = 0;
    this.ring = null;

    this._hp = null;
    this._hopBuf = null;
    this._hopN = 0;
    this._hopFrame = 0;
    this._bgRms = null;
    this._hopCount = 0;
    this._lastTransientMs = -Infinity;
    this._lastChunkEnd = null;
    this._startSeq = 0;
  }

  get running() {
    if (!this.ctx || this.ctx.state !== "running" || !this.stream) return false;
    return this.stream.getAudioTracks().some((t) => t.readyState === "live");
  }

  get currentFrame() {
    if (this.ctx && this.sampleRate > 0) {
      return Math.round(this.ctx.currentTime * this.sampleRate);
    }
    return this.ring && this.ring.started ? this.ring.end : null;
  }

  setLiveTransientEnabled(enabled) {
    const next = Boolean(enabled);
    if (next && !this.liveTransientEnabled) {
      this._resetTransientState();
    }
    this.liveTransientEnabled = next;
  }

  setTransientCallback(fn) {
    this.onTransient = typeof fn === "function" ? fn : null;
  }

  _resetTransientState() {
    if (!this.sampleRate) {
      this._hp = null;
      this._hopBuf = null;
      return;
    }
    this._hp = createHighpassBiquad(this.transientHighpassHz, this.sampleRate);
    const hopSize = Math.max(64, Math.round(0.005 * this.sampleRate));
    this._hopBuf = new Float32Array(hopSize);
    this._hopN = 0;
    this._hopFrame = 0;
    this._bgRms = null;
    this._hopCount = 0;
    this._lastTransientMs = -Infinity;
    this._lastChunkEnd = null;
    this._startSeq = 0;
  }

  /**
   * Initialize AudioContext, microphone stream, and rq-capture AudioWorklet.
   * Synchronously calls ctx.resume() before getUserMedia for iOS Safari gesture unlock.
   */
  async startMic() {
    if (this.running) {
      return { sampleRate: this.sampleRate, state: this.ctx.state };
    }
    if (this.ctx) {
      await this.stopMic();
    }

    const seq = ++this._startSeq;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) {
      throw new Error("Web Audio API is unavailable in this browser.");
    }

    const ctx = new AC({ latencyHint: "interactive" });
    this.ctx = ctx;

    // Must happen synchronously before any await so Safari keeps the user gesture.
    const resumePromise =
      typeof ctx.resume === "function" ? ctx.resume() : Promise.resolve();

    try {
      if (typeof navigator !== "undefined" && navigator.audioSession) {
        navigator.audioSession.type = "play-and-record";
      }
    } catch {
      // Ignore if audioSession is read-only or restricted.
    }

    try {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function"
      ) {
        throw new Error("Microphone capture (getUserMedia) is unavailable.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });

      if (seq !== this._startSeq) {
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch {}
        }
        try {
          if (ctx.state !== "closed") await ctx.close();
        } catch {}
        return null;
      }
      this.stream = stream;

      await resumePromise;
      if (ctx.state !== "running" && typeof ctx.resume === "function") {
        await ctx.resume();
      }

      await ctx.audioWorklet.addModule(this.workletUrl);
      if (seq !== this._startSeq) {
        await this.stopMic();
        return null;
      }

      this.sampleRate = ctx.sampleRate;
      this.ring = new FrameRingBuffer(
        Math.round(this.sampleRate * this.ringSeconds),
      );
      this._resetTransientState();

      this.source = ctx.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(ctx, "rq-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      // Keep the worklet pulling without feeding microphone audio back to speakers.
      this.silentSink = ctx.createGain();
      this.silentSink.gain.value = 0;
      this.source.connect(this.workletNode);
      this.workletNode.connect(this.silentSink);
      this.silentSink.connect(ctx.destination);

      this.outputGain = ctx.createGain();
      this.outputGain.connect(ctx.destination);

      this.workletNode.port.onmessage = (event) => {
        const data = event?.data;
        if (!data || !data.samples) return;
        this.ingestChunk(data.frame, data.samples);
      };

      return { sampleRate: this.sampleRate, state: ctx.state };
    } catch (err) {
      await this.stopMic();
      throw err;
    }
  }

  /**
   * Stop AudioWorklet, release MediaStreamTracks, and close the AudioContext.
   */
  async stopMic() {
    this._startSeq++;
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: "stop" });
      } catch {}
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {}
      this.workletNode = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {}
      this.source = null;
    }
    if (this.silentSink) {
      try {
        this.silentSink.disconnect();
      } catch {}
      this.silentSink = null;
    }
    if (this.outputGain) {
      try {
        this.outputGain.disconnect();
      } catch {}
      this.outputGain = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      this.stream = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      try {
        if (ctx.state !== "closed") {
          await ctx.close();
        }
      } catch {}
    }
  }

  /**
   * Schedule and play a Hann-windowed calibration chirp; returns the scheduled
   * local AudioContext frame.
   */
  playCalibrationChirp({
    f0 = 2000,
    f1 = 6000,
    durationSec = 0.08,
    gain = 0.35,
    leadSec = 0.05,
    scheduledFrame = null,
  } = {}) {
    if (!this.ctx || this.ctx.state === "closed") {
      throw new Error("AudioContext is not active; call startMic() first.");
    }
    const sr = this.ctx.sampleRate;
    const chirp = generateChirp(sr, { f0, f1, durationSec, gain });
    const buffer = this.ctx.createBuffer(1, chirp.length, sr);
    if (typeof buffer.copyToChannel === "function") {
      buffer.copyToChannel(chirp, 0);
    } else if (typeof buffer.getChannelData === "function") {
      buffer.getChannelData(0).set(chirp);
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.outputGain || this.ctx.destination);

    const nowSec = this.ctx.currentTime;
    let whenSec =
      scheduledFrame == null ? nowSec + leadSec : scheduledFrame / sr;
    if (whenSec < nowSec + 0.01) whenSec = nowSec + 0.02;

    src.start(whenSec);
    return Math.round(whenSec * sr);
  }

  /**
   * Correlate the local ring buffer around expectedFrame without uploading PCM.
   * Returns ONLY { frame, snr, peak } or null.
   */
  findLocalChirp(
    expectedFrame,
    windowBeforeSec = 0.35,
    windowAfterSec = 0.65,
    params = {},
  ) {
    if (!this.ring || !this.ring.started || !this.sampleRate) return null;
    if (!Number.isFinite(expectedFrame)) return null;

    const sr = this.sampleRate;
    const template =
      params.template ||
      generateChirp(sr, {
        f0: params.f0 ?? 2000,
        f1: params.f1 ?? 6000,
        durationSec: params.durationSec ?? 0.08,
        gain: params.gain ?? 0.35,
      });

    const rawStart = Math.floor(expectedFrame - windowBeforeSec * sr);
    const rawEnd = Math.ceil(
      expectedFrame + windowAfterSec * sr + template.length - 1,
    );
    // Clamp strictly to valid ring bounds so unrecorded leading zeros do not
    // artificially collapse the median correlation noise floor.
    const startFrame = Math.max(rawStart, this.ring.start);
    const endFrame = Math.min(rawEnd, this.ring.end);
    if (endFrame - startFrame < template.length + 4) return null;

    const { samples } = this.ring.read(startFrame, endFrame);
    const det = detectChirpCorrelation(samples, template, {
      sampleRate: sr,
      minSnr: params.minSnr ?? 6.0,
      firstArrivalFrac: params.firstArrivalFrac ?? 0.55,
    });
    if (!det) return null;

    return {
      frame: startFrame + det.index,
      snr: det.snr,
      peak: det.peak,
    };
  }

  /**
   * Ingest a frame-tagged audio chunk into the ring buffer and run the
   * on-device transient analyzer if liveTransientEnabled is true.
   */
  ingestChunk(frame, samples, sampleRateOverride = null) {
    if (!samples || samples.length === 0) return;
    if (sampleRateOverride && !this.sampleRate) {
      this.sampleRate = sampleRateOverride;
    }
    if (!this.ring && this.sampleRate > 0) {
      this.ring = new FrameRingBuffer(
        Math.round(this.sampleRate * this.ringSeconds),
      );
      this._resetTransientState();
    }
    if (!this.ring) return;

    this.ring.write(frame, samples);

    if (this.liveTransientEnabled) {
      this._processTransientChunk(frame, samples);
    } else {
      this._lastChunkEnd = frame + samples.length;
    }
  }

  _processTransientChunk(frame, samples) {
    if (!this._hp || !this._hopBuf) this._resetTransientState();
    if (!this._hp || !this._hopBuf || !this.sampleRate) return;

    if (this._lastChunkEnd !== null && frame !== this._lastChunkEnd) {
      // Reset filter/hop accumulation across clock discontinuities.
      this._hp.x1 = this._hp.x2 = this._hp.y1 = this._hp.y2 = 0;
      this._hopN = 0;
    }
    this._lastChunkEnd = frame + samples.length;

    const hopLen = this._hopBuf.length;
    let i = 0;
    while (i < samples.length) {
      if (this._hopN === 0) this._hopFrame = frame + i;
      const take = Math.min(hopLen - this._hopN, samples.length - i);
      this._hopBuf.set(samples.subarray(i, i + take), this._hopN);
      this._hopN += take;
      i += take;

      if (this._hopN === hopLen) {
        this._analyzeHop(
          this._hopFrame,
          this._hopBuf,
          frame + samples.length,
        );
        this._hopN = 0;
      }
    }
  }

  _analyzeHop(hopStartFrame, hopSamples, chunkEndFrame) {
    const f = this._hp;
    const n = hopSamples.length;
    let sumSq = 0;
    let peakAbs = 0;

    for (let i = 0; i < n; i++) {
      const x = hopSamples[i];
      const y =
        f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
      f.x2 = f.x1;
      f.x1 = x;
      f.y2 = f.y1;
      f.y1 = y;
      sumSq += y * y;
      const ay = Math.abs(y);
      if (ay > peakAbs) peakAbs = ay;
    }

    const shortRms = Math.sqrt(sumSq / n + 1e-12);
    const sr = this.sampleRate;
    const hopSec = n / sr;

    if (this._bgRms === null) {
      this._bgRms = Math.max(1e-5, shortRms);
    }

    this._hopCount++;
    const snrDb = 20 * Math.log10(shortRms / Math.max(this._bgRms, 1e-9));

    const latestFrame = this.ctx
      ? Math.max(chunkEndFrame, Math.round(this.ctx.currentTime * sr))
      : chunkEndFrame;
    const lagMs = Math.max(0, ((latestFrame - hopStartFrame) / sr) * 1000);
    const t = this._now() - lagMs;

    if (
      this._hopCount > 6 &&
      snrDb >= this.transientThresholdDb &&
      shortRms >= this.transientMinRms &&
      t - this._lastTransientMs >= this.transientRefractoryMs
    ) {
      this._lastTransientMs = t;
      const confidence = Math.max(
        0,
        Math.min(1, 0.5 + (snrDb - this.transientThresholdDb) / 20),
      );
      const peakDb = 20 * Math.log10(Math.max(peakAbs, 1e-6));
      if (this.onTransient) {
        this.onTransient({ t, confidence, peakDb });
      }
    }

    // Winsorized EWMA keeps sharp transients from immediately inflating background RMS.
    const alphaBg = 1 - Math.exp(-hopSec / 0.8);
    const capped = Math.min(shortRms, this._bgRms * 2.5);
    this._bgRms += alphaBg * (capped - this._bgRms);
    this._bgRms = Math.max(1e-5, this._bgRms);
  }
}
