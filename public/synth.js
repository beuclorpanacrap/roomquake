/**
 * Zero-dependency native Web Audio API synthesizer for RoomQuake.
 * Safe to import in Node (checks AudioContext lazily inside unlock()).
 */

export const FREE_PLAY_POOL = Object.freeze([50, 57, 64, 65, 69, 72, 76, 79]);

// Warm dyad/triad/tetrad voicings built strictly from FREE_PLAY_POOL with smooth voice leading.
const FREE_PLAY_VOICINGS = Object.freeze([
  [50, 57, 64, 69], // Dm9 open
  [57, 65, 72, 76], // Fmaj7/A
  [50, 65, 69, 72], // Dm7
  [57, 64, 72, 79], // Am7
  [50, 64, 69, 76], // Dm(add9)
  [57, 65, 69, 79], // F6/9
  [50, 57, 72, 76], // Dm11 open
  [57, 65, 72, 79], // Fmaj9/A
]);

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function getAudioContextCtor() {
  const win = typeof window !== "undefined" ? window : globalThis;
  return win?.AudioContext || win?.webkitAudioContext || null;
}

function createMulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RoomQuakeSynth {
  constructor({ masterGain = 0.85, reverbMix = 0.34, maxVoices = 18 } = {}) {
    this.ctx = null;
    this.voiceBus = null;
    this.dryGain = null;
    this.wetGain = null;
    this.reverbSendFilter = null;
    this.convolver = null;
    this.compressor = null;
    this.masterGainNode = null;
    this._noiseBuffer = null;

    this.masterGainValue = clamp(masterGain, 0, 1.5);
    this.reverbMixValue = clamp(reverbMix, 0, 1);
    this.maxVoices = Math.max(4, Math.floor(maxVoices));
    this.activeVoices = [];
    this._freeStep = -1;
  }

  /**
   * Returns current audio engine state without constructing a context.
   * @returns {"unsupported" | "locked" | "running" | "suspended"}
   */
  getState() {
    if (!getAudioContextCtor()) return "unsupported";
    if (!this.ctx || this.ctx.state === "closed") return "locked";
    if (this.ctx.state === "running") return "running";
    return "suspended";
  }

  /**
   * Synchronously creates AudioContext and calls resume() within the user gesture.
   * @returns {Promise<boolean>}
   */
  unlock() {
    const AudioCtx = getAudioContextCtor();
    if (!AudioCtx) return Promise.resolve(false);

    if (!this.ctx || this.ctx.state === "closed") {
      try {
        this.ctx = new AudioCtx({ latencyHint: "interactive" });
      } catch {
        this.ctx = new AudioCtx();
      }
      this._buildMasterGraph();
    }

    if (this.ctx.state === "running") {
      return Promise.resolve(true);
    }

    let resumePromise;
    try {
      resumePromise = this.ctx.resume();
    } catch {
      return Promise.resolve(false);
    }

    return Promise.resolve(resumePromise)
      .then(() => this.ctx?.state === "running")
      .catch(() => false);
  }

  setMasterGain(value) {
    if (!Number.isFinite(value)) return;
    this.masterGainValue = clamp(value, 0, 1.5);
    if (this.masterGainNode && this.ctx) {
      this.masterGainNode.gain.setTargetAtTime(
        this.masterGainValue,
        this.ctx.currentTime,
        0.02,
      );
    }
  }

  setReverbMix(value) {
    if (!Number.isFinite(value)) return;
    this.reverbMixValue = clamp(value, 0, 1);
    if (this.dryGain && this.wetGain && this.ctx) {
      const { dry, wet } = this._computeWetDryGains(this.reverbMixValue);
      this.dryGain.gain.setTargetAtTime(dry, this.ctx.currentTime, 0.025);
      this.wetGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.025);
    }
  }

  /**
   * Immediately fades out all currently ringing voices.
   */
  stopAll() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    while (this.activeVoices.length > 0) {
      const voice = this.activeVoices.shift();
      voice.steal(now);
    }
  }

  /**
   * Plays a consonant Free Play harmony hit mapped by intensity, spacing, and voice.
   */
  playFreeHit({ intensity = 0.6, spacingMs = 600, voice = "strings" } = {}) {
    if (!this.ctx || this.ctx.state !== "running") return null;

    const normIntensity = clamp(intensity, 0, 1);
    const safeSpacing = clamp(spacingMs, 60, 4000);
    const voiceType = voice === "bells" || voice === "harp" ? voice : "strings";

    // Rotate smoothly across voicings; reset toward tonic Dm9 after a long silence.
    if (safeSpacing > 3200 || this._freeStep < 0) {
      this._freeStep = 0;
    } else {
      this._freeStep = (this._freeStep + 1) % FREE_PLAY_VOICINGS.length;
    }
    const baseVoicing = FREE_PLAY_VOICINGS[this._freeStep];

    // Closer taps -> tighter upper shimmer; spacious taps -> fuller root + fifth + ninth bloom.
    const spaceNorm = clamp((safeSpacing - 120) / (1500 - 120), 0, 1);
    const releaseSec = 1.1 + spaceNorm * 1.7;
    let notes;
    if (safeSpacing < 280) {
      notes = baseVoicing.slice(-2);
    } else if (safeSpacing < 650) {
      notes = [baseVoicing[0], baseVoicing[2], baseVoicing[3]];
    } else {
      notes = baseVoicing.slice();
    }

    const brightnessHz = 650 + Math.pow(normIntensity, 1.15) * (3400 - 650);
    const baseGain =
      (0.16 + Math.pow(normIntensity, 0.85) * 0.34) / Math.sqrt(notes.length);
    const now = this.ctx.currentTime;
    const staggerSec = spaceNorm > 0.45 ? 0.011 : 0.004;

    notes.forEach((midi, idx) => {
      const startTime = now + idx * staggerSec;
      if (voiceType === "bells") {
        this._spawnBellVoice(midi, startTime, baseGain, releaseSec, brightnessHz, false);
      } else if (voiceType === "harp") {
        this._spawnHarpVoice(midi, startTime, baseGain, releaseSec, brightnessHz);
      } else {
        const attackSec = 0.08 - 0.04 * normIntensity; // 40–80 ms soft bow attack
        this._spawnStringsVoice(
          midi,
          startTime,
          baseGain,
          attackSec,
          releaseSec,
          brightnessHz,
        );
      }
    });

    return {
      voice: voiceType,
      notes,
      intensity: normIntensity,
      brightnessHz,
      releaseSec,
    };
  }

  /**
   * Renders an arranged Play Assist step with distinct orchestral timbres per layer.
   */
  playAssistStep(step, intensity = 0.7) {
    if (!this.ctx || this.ctx.state !== "running" || !step) return null;
    const notes = Array.isArray(step.notes)
      ? step.notes.filter((n) => Number.isFinite(n) && n >= 0 && n <= 127)
      : [];
    if (notes.length === 0) return null;

    const normIntensity = clamp(intensity, 0, 1);
    const expr = 0.65 + 0.35 * normIntensity;
    const baseDuration = clamp(step.durationSec ?? 1.8, 0.3, 6.0);
    const baseGain = clamp(step.gain ?? 0.78, 0.05, 1.1) * expr;
    const layer = step.layer || "strings";
    const now = this.ctx.currentTime;

    this._renderOrchestralLayer(layer, notes, now, baseGain, baseDuration, expr);

    const renderedLayers = [layer];
    if (Array.isArray(step.extraLayers)) {
      for (const extra of step.extraLayers) {
        if (!extra || !extra.layer) continue;
        const extraNotes =
          Array.isArray(extra.notes) && extra.notes.length > 0 ? extra.notes : notes;
        const extraGain = clamp(extra.gain ?? (step.gain ?? 0.75) * 0.65, 0.05, 1.1) * expr;
        const extraDur = clamp(extra.durationSec ?? baseDuration, 0.3, 6.0);
        this._renderOrchestralLayer(
          extra.layer,
          extraNotes,
          now,
          extraGain,
          extraDur,
          expr,
        );
        renderedLayers.push(extra.layer);
      }
    }

    if (step.accentTimb && !renderedLayers.includes("timpani")) {
      const lowestNote = Math.min(...notes);
      this._renderOrchestralLayer(
        "timpani",
        [lowestNote],
        now,
        clamp(baseGain * 0.85, 0.15, 0.95),
        Math.min(1.6, baseDuration),
        expr,
      );
      renderedLayers.push("timpani");
    }

    return {
      layers: renderedLayers,
      notes,
      intensity: normIntensity,
      expression: expr,
    };
  }

  _computeWetDryGains(mix) {
    return {
      dry: Math.cos(mix * Math.PI * 0.35),
      wet: Math.sin(mix * Math.PI * 0.5) * 0.85,
    };
  }

  _buildMasterGraph() {
    const ctx = this.ctx;
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 1;

    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    const { dry, wet } = this._computeWetDryGains(this.reverbMixValue);
    this.dryGain.gain.value = dry;
    this.wetGain.gain.value = wet;

    this.reverbSendFilter = ctx.createBiquadFilter();
    this.reverbSendFilter.type = "lowpass";
    this.reverbSendFilter.frequency.value = 4200;
    this.reverbSendFilter.Q.value = 0.5;

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this._createHallImpulseResponse(ctx, 2.4);

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -10;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.18;

    this.masterGainNode = ctx.createGain();
    this.masterGainNode.gain.value = this.masterGainValue;

    this.voiceBus.connect(this.dryGain);
    this.dryGain.connect(this.compressor);

    this.voiceBus.connect(this.reverbSendFilter);
    this.reverbSendFilter.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.compressor);

    this.compressor.connect(this.masterGainNode);
    this.masterGainNode.connect(ctx.destination);

    this._noiseBuffer = this._createNoiseBuffer(ctx, 0.8);
  }

  _createHallImpulseResponse(ctx, durationSec) {
    const sampleRate = ctx.sampleRate || 48000;
    const length = Math.max(1, Math.floor(sampleRate * durationSec));
    const buffer = ctx.createBuffer(2, length, sampleRate);
    const rand = createMulberry32(0x526f6f6d);

    const earlyReflections = [
      { ms: 11, l: 0.48, r: 0.22 },
      { ms: 19, l: 0.24, r: 0.44 },
      { ms: 29, l: 0.36, r: 0.31 },
      { ms: 43, l: 0.22, r: 0.34 },
      { ms: 61, l: 0.26, r: 0.18 },
      { ms: 79, l: 0.16, r: 0.24 },
    ];

    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    let lpL = 0;
    let lpR = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const progress = t / durationSec;
      const attackEnv = Math.min(1, t / 0.012);
      const decayEnv = Math.exp(-t * 2.55) * (1 - progress * 0.15);
      // Warm cathedral air absorption: high frequencies damp smoothly over the tail.
      const dampCoeff = 0.42 - 0.26 * progress;

      const whiteL = rand() * 2 - 1;
      const whiteR = rand() * 2 - 1;
      lpL += dampCoeff * (whiteL - lpL);
      lpR += dampCoeff * (whiteR - lpR);

      left[i] = lpL * attackEnv * decayEnv * 0.24;
      right[i] = lpR * attackEnv * decayEnv * 0.24;
    }

    for (const tap of earlyReflections) {
      const idx = Math.floor((tap.ms / 1000) * sampleRate);
      if (idx > 0 && idx < length) {
        left[idx] += tap.l * 0.35;
        right[idx] += tap.r * 0.35;
      }
    }

    return buffer;
  }

  _createNoiseBuffer(ctx, durationSec) {
    const sampleRate = ctx.sampleRate || 48000;
    const length = Math.max(1, Math.floor(sampleRate * durationSec));
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    const rand = createMulberry32(0x5175616b);
    for (let i = 0; i < length; i++) {
      data[i] = rand() * 2 - 1;
    }
    return buffer;
  }

  _trackVoice(endTime, gainNode, sources, cleanupNodes = [], startTime = 0) {
    const now = this.ctx.currentTime;
    this.activeVoices = this.activeVoices.filter(
      (v) => !v.stopped && v.endTime > now,
    );

    while (this.activeVoices.length >= this.maxVoices) {
      const oldest = this.activeVoices.shift();
      oldest.steal(now);
    }

    const record = {
      endTime,
      stopped: false,
      steal: (stealAt) => {
        if (record.stopped) return;
        record.stopped = true;
        const stopAt = Math.max(stealAt + 0.03, startTime + 0.005);
        try {
          gainNode.gain.cancelScheduledValues(stealAt);
          const currentVal = Math.max(0.0001, gainNode.gain.value || 0.002);
          gainNode.gain.setValueAtTime(currentVal, stealAt);
          gainNode.gain.linearRampToValueAtTime(0.0001, stopAt - 0.005);
        } catch {
          // Ignore parameter scheduling errors on closed or mock nodes.
        }
        for (const src of sources) {
          try {
            src.stop(stopAt);
          } catch {
            // Source may have already stopped.
          }
        }
      },
    };

    const primary = sources[0];
    if (primary && "onended" in primary) {
      primary.onended = () => {
        record.stopped = true;
        for (const node of [...sources, ...cleanupNodes, gainNode]) {
          try {
            node.disconnect();
          } catch {
            // Safe disconnect guard.
          }
        }
      };
    }

    this.activeVoices.push(record);
  }

  _renderOrchestralLayer(layer, notes, startTime, gain, durationSec, expr) {
    const scaledGain = clamp(gain, 0.04, 1.0) / Math.sqrt(Math.max(1, notes.length));
    switch (layer) {
      case "bass": {
        const brightness = 460 + 520 * expr;
        for (const midi of notes) {
          this._spawnBassVoice(midi, startTime, scaledGain * 0.42, durationSec, brightness);
        }
        break;
      }
      case "brass": {
        const brightness = 950 + 2150 * expr;
        for (const midi of notes) {
          this._spawnBrassVoice(midi, startTime, scaledGain * 0.34, durationSec, brightness);
        }
        break;
      }
      case "choir": {
        for (const midi of notes) {
          this._spawnChoirVoice(midi, startTime, scaledGain * 0.38, durationSec, expr);
        }
        break;
      }
      case "timpani": {
        const bassNote = Math.min(...notes);
        this._spawnTimpaniVoice(bassNote, startTime, clamp(gain * 0.52, 0.12, 0.65), durationSec);
        break;
      }
      case "bell": {
        const brightness = 1600 + 2200 * expr;
        for (const midi of notes) {
          this._spawnBellVoice(midi, startTime, scaledGain * 0.36, Math.max(2.2, durationSec * 1.3), brightness, true);
        }
        break;
      }
      case "strings":
      default: {
        const brightness = 900 + 1850 * expr;
        for (const midi of notes) {
          this._spawnStringsVoice(
            midi,
            startTime,
            scaledGain * 0.36,
            0.068,
            durationSec,
            brightness,
          );
        }
        break;
      }
    }
  }

  _spawnStringsVoice(midi, startTime, peakGain, attackSec, releaseSec, brightnessHz) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const endTime = startTime + attackSec + releaseSec;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1.5;
    filter.frequency.setValueAtTime(Math.max(260, brightnessHz * 0.55), startTime);
    filter.frequency.linearRampToValueAtTime(brightnessHz, startTime + attackSec * 1.4);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(240, brightnessHz * 0.38),
      endTime,
    );

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(Math.max(0.002, peakGain), startTime + attackSec);
    env.gain.exponentialRampToValueAtTime(0.0001, endTime);

    const oscA = ctx.createOscillator();
    oscA.type = "sawtooth";
    oscA.frequency.setValueAtTime(freq, startTime);
    oscA.detune.setValueAtTime(-7, startTime);

    const oscB = ctx.createOscillator();
    oscB.type = "sawtooth";
    oscB.frequency.setValueAtTime(freq, startTime);
    oscB.detune.setValueAtTime(7, startTime);

    const oscSub = ctx.createOscillator();
    oscSub.type = "triangle";
    oscSub.frequency.setValueAtTime(freq, startTime);

    oscA.connect(filter);
    oscB.connect(filter);
    oscSub.connect(filter);
    filter.connect(env);
    env.connect(this.voiceBus);

    const stopAt = endTime + 0.04;
    oscA.start(startTime);
    oscB.start(startTime);
    oscSub.start(startTime);
    oscA.stop(stopAt);
    oscB.stop(stopAt);
    oscSub.stop(stopAt);

    this._trackVoice(endTime, env, [oscA, oscB, oscSub], [filter], startTime);
  }

  _spawnBellVoice(midi, startTime, peakGain, releaseSec, brightnessHz, tubular) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const attackSec = 0.008;
    const endTime = startTime + attackSec + releaseSec;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(Math.min(7200, brightnessHz * 1.45), startTime);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(420, brightnessHz * 0.55),
      endTime,
    );

    const masterEnv = ctx.createGain();
    masterEnv.gain.setValueAtTime(0.0001, startTime);
    masterEnv.gain.linearRampToValueAtTime(Math.max(0.002, peakGain), startTime + attackSec);
    masterEnv.gain.exponentialRampToValueAtTime(0.0001, endTime);

    const partials = tubular
      ? [
          { ratio: 1.0, weight: 0.72, decay: 1.0 },
          { ratio: 1.5, weight: 0.42, decay: 0.82 },
          { ratio: 2.0, weight: 0.34, decay: 0.68 },
          { ratio: 2.76, weight: 0.22, decay: 0.48 },
          { ratio: 3.98, weight: 0.14, decay: 0.32 },
        ]
      : [
          { ratio: 1.0, weight: 0.75, decay: 1.0 },
          { ratio: 2.0, weight: 0.38, decay: 0.72 },
          { ratio: 3.01, weight: 0.22, decay: 0.48 },
          { ratio: 4.98, weight: 0.12, decay: 0.3 },
        ];

    const sources = [];
    const extraNodes = [filter];

    for (const p of partials) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq * p.ratio, startTime);

      const pGain = ctx.createGain();
      const pEnd = startTime + attackSec + releaseSec * p.decay;
      pGain.gain.setValueAtTime(p.weight, startTime);
      pGain.gain.exponentialRampToValueAtTime(0.0001, pEnd);

      osc.connect(pGain);
      pGain.connect(filter);
      osc.start(startTime);
      osc.stop(pEnd + 0.03);

      sources.push(osc);
      extraNodes.push(pGain);
    }

    filter.connect(masterEnv);
    masterEnv.connect(this.voiceBus);

    this._trackVoice(endTime, masterEnv, sources, extraNodes, startTime);
  }

  _spawnHarpVoice(midi, startTime, peakGain, releaseSec, brightnessHz) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const attackSec = 0.006;
    const endTime = startTime + attackSec + releaseSec * 0.92;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(Math.min(6400, brightnessHz * 2.1), startTime);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(300, brightnessHz * 0.42),
      startTime + 0.22,
    );

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(Math.max(0.002, peakGain), startTime + attackSec);
    env.gain.exponentialRampToValueAtTime(0.0001, endTime);

    const tri = ctx.createOscillator();
    tri.type = "triangle";
    tri.frequency.setValueAtTime(freq, startTime);

    const sine = ctx.createOscillator();
    sine.type = "sine";
    sine.frequency.setValueAtTime(freq, startTime);

    const harmonic = ctx.createOscillator();
    harmonic.type = "sine";
    harmonic.frequency.setValueAtTime(freq * 2, startTime);
    const harmGain = ctx.createGain();
    harmGain.gain.setValueAtTime(0.24, startTime);
    harmGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.35);

    tri.connect(filter);
    sine.connect(filter);
    harmonic.connect(harmGain);
    harmGain.connect(filter);

    filter.connect(env);
    env.connect(this.voiceBus);

    const stopAt = endTime + 0.04;
    tri.start(startTime);
    sine.start(startTime);
    harmonic.start(startTime);
    tri.stop(stopAt);
    sine.stop(stopAt);
    harmonic.stop(startTime + 0.38);

    this._trackVoice(endTime, env, [tri, sine, harmonic], [filter, harmGain], startTime);
  }

  _spawnBassVoice(midi, startTime, peakGain, durationSec, brightnessHz) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const attackSec = 0.065;
    const endTime = startTime + attackSec + durationSec;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1.1;
    filter.frequency.setValueAtTime(Math.max(180, brightnessHz * 0.5), startTime);
    filter.frequency.linearRampToValueAtTime(brightnessHz, startTime + 0.11);
    filter.frequency.exponentialRampToValueAtTime(Math.max(160, brightnessHz * 0.4), endTime);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(Math.max(0.002, peakGain), startTime + attackSec);
    env.gain.exponentialRampToValueAtTime(0.0001, endTime);

    const sawL = ctx.createOscillator();
    sawL.type = "sawtooth";
    sawL.frequency.setValueAtTime(freq, startTime);
    sawL.detune.setValueAtTime(-4, startTime);

    const sawR = ctx.createOscillator();
    sawR.type = "sawtooth";
    sawR.frequency.setValueAtTime(freq, startTime);
    sawR.detune.setValueAtTime(4, startTime);

    const sub = ctx.createOscillator();
    sub.type = "triangle";
    sub.frequency.setValueAtTime(midi >= 36 ? freq * 0.5 : freq, startTime);
    const subGain = ctx.createGain();
    subGain.gain.value = 0.55;

    sawL.connect(filter);
    sawR.connect(filter);
    sub.connect(subGain);
    subGain.connect(filter);

    filter.connect(env);
    env.connect(this.voiceBus);

    const stopAt = endTime + 0.04;
    sawL.start(startTime);
    sawR.start(startTime);
    sub.start(startTime);
    sawL.stop(stopAt);
    sawR.stop(stopAt);
    sub.stop(stopAt);

    this._trackVoice(endTime, env, [sawL, sawR, sub], [filter, subGain], startTime);
  }

  _spawnBrassVoice(midi, startTime, peakGain, durationSec, brightnessHz) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const attackSec = 0.075;
    const endTime = startTime + attackSec + durationSec;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 2.2;
    filter.frequency.setValueAtTime(280, startTime);
    filter.frequency.linearRampToValueAtTime(brightnessHz, startTime + 0.13);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(320, brightnessHz * 0.35),
      endTime,
    );

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(Math.max(0.002, peakGain), startTime + attackSec);
    env.gain.exponentialRampToValueAtTime(0.0001, endTime);

    const sawA = ctx.createOscillator();
    sawA.type = "sawtooth";
    sawA.frequency.setValueAtTime(freq, startTime);
    sawA.detune.setValueAtTime(-3.5, startTime);

    const sawB = ctx.createOscillator();
    sawB.type = "sawtooth";
    sawB.frequency.setValueAtTime(freq, startTime);
    sawB.detune.setValueAtTime(3.5, startTime);

    sawA.connect(filter);
    sawB.connect(filter);
    filter.connect(env);
    env.connect(this.voiceBus);

    const stopAt = endTime + 0.04;
    sawA.start(startTime);
    sawB.start(startTime);
    sawA.stop(stopAt);
    sawB.stop(stopAt);

    this._trackVoice(endTime, env, [sawA, sawB], [filter], startTime);
  }

  _spawnChoirVoice(midi, startTime, peakGain, durationSec, expr) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const attackSec = 0.13;
    const endTime = startTime + attackSec + durationSec * 1.08;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(Math.max(0.002, peakGain), startTime + attackSec);
    env.gain.exponentialRampToValueAtTime(0.0001, endTime);

    // Parallel vocal formant filters ("Ooh/Ah" blend) + warm fundamental support.
    const f1 = ctx.createBiquadFilter();
    f1.type = "bandpass";
    f1.frequency.value = 560 + 80 * expr;
    f1.Q.value = 4.2;

    const f2 = ctx.createBiquadFilter();
    f2.type = "bandpass";
    f2.frequency.value = 1040 + 220 * expr;
    f2.Q.value = 5.0;

    const warmBody = ctx.createBiquadFilter();
    warmBody.type = "lowpass";
    warmBody.frequency.value = 950 + 450 * expr;
    warmBody.Q.value = 0.8;

    const f1Gain = ctx.createGain();
    f1Gain.gain.value = 0.85;
    const f2Gain = ctx.createGain();
    f2Gain.gain.value = 0.45;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.42;

    const oscA = ctx.createOscillator();
    oscA.type = "sawtooth";
    oscA.frequency.setValueAtTime(freq, startTime);
    oscA.detune.setValueAtTime(-6, startTime);

    const oscB = ctx.createOscillator();
    oscB.type = "sawtooth";
    oscB.frequency.setValueAtTime(freq, startTime);
    oscB.detune.setValueAtTime(6, startTime);

    oscA.connect(f1);
    oscB.connect(f1);
    oscA.connect(f2);
    oscB.connect(f2);
    oscA.connect(warmBody);
    oscB.connect(warmBody);

    f1.connect(f1Gain);
    f2.connect(f2Gain);
    warmBody.connect(bodyGain);

    f1Gain.connect(env);
    f2Gain.connect(env);
    bodyGain.connect(env);
    env.connect(this.voiceBus);

    const stopAt = endTime + 0.04;
    oscA.start(startTime);
    oscB.start(startTime);
    oscA.stop(stopAt);
    oscB.stop(stopAt);

    this._trackVoice(
      endTime,
      env,
      [oscA, oscB],
      [f1, f2, warmBody, f1Gain, f2Gain, bodyGain],
      startTime,
    );
  }

  _spawnTimpaniVoice(midi, startTime, peakGain, durationSec) {
    const ctx = this.ctx;
    // Normalize pitch into authentic kettle-drum fundamental range (MIDI 33..48).
    let drumMidi = midi;
    while (drumMidi > 48) drumMidi -= 12;
    while (drumMidi < 33) drumMidi += 12;

    const freq = midiToFreq(drumMidi);
    const tailSec = Math.min(1.65, Math.max(0.85, durationSec * 0.8));
    const endTime = startTime + tailSec;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(Math.max(0.004, peakGain), startTime + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, endTime);

    // Membrane pitch drop on impact.
    const bodyOsc = ctx.createOscillator();
    bodyOsc.type = "sine";
    bodyOsc.frequency.setValueAtTime(freq * 1.48, startTime);
    bodyOsc.frequency.exponentialRampToValueAtTime(freq, startTime + 0.045);

    const overOsc = ctx.createOscillator();
    overOsc.type = "triangle";
    overOsc.frequency.setValueAtTime(freq * 1.5, startTime);
    const overGain = ctx.createGain();
    overGain.gain.setValueAtTime(0.28, startTime);
    overGain.gain.exponentialRampToValueAtTime(0.0001, startTime + tailSec * 0.45);

    bodyOsc.connect(env);
    overOsc.connect(overGain);
    overGain.connect(env);

    const sources = [bodyOsc, overOsc];
    const extraNodes = [overGain];

    if (this._noiseBuffer) {
      const mallet = ctx.createBufferSource();
      mallet.buffer = this._noiseBuffer;

      const malletFilter = ctx.createBiquadFilter();
      malletFilter.type = "lowpass";
      malletFilter.frequency.setValueAtTime(520, startTime);
      malletFilter.Q.value = 1.2;

      const malletGain = ctx.createGain();
      malletGain.gain.setValueAtTime(0.32, startTime);
      malletGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.032);

      mallet.connect(malletFilter);
      malletFilter.connect(malletGain);
      malletGain.connect(env);
      mallet.start(startTime);
      mallet.stop(startTime + 0.045);

      sources.push(mallet);
      extraNodes.push(malletFilter, malletGain);
    }

    env.connect(this.voiceBus);

    const stopAt = endTime + 0.04;
    bodyOsc.start(startTime);
    overOsc.start(startTime);
    bodyOsc.stop(stopAt);
    overOsc.stop(stopAt);

    this._trackVoice(endTime, env, sources, extraNodes, startTime);
  }
}
