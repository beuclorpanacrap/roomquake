import test from "node:test";
import assert from "node:assert/strict";
import {
  ASHEN_CATHEDRAL_CUE,
  PlayAssistSequencer,
} from "../public/assist.js";
import {
  parseMidiArrayBuffer,
  groupTrackToAssistSteps,
} from "../public/midi.js";
import { RoomQuakeSynth, FREE_PLAY_POOL } from "../public/synth.js";

function writeUint16(buf, val) {
  buf.push((val >> 8) & 0xff, val & 0xff);
}

function writeUint32(buf, val) {
  buf.push(
    (val >>> 24) & 0xff,
    (val >>> 16) & 0xff,
    (val >>> 8) & 0xff,
    val & 0xff,
  );
}

function writeAscii(buf, str) {
  for (let i = 0; i < str.length; i++) {
    buf.push(str.charCodeAt(i) & 0xff);
  }
}

function writeVLQ(buf, value) {
  const bytes = [value & 0x7f];
  let v = value >>> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  buf.push(...bytes);
}

function buildChunk(id, bodyBytes) {
  const chunk = [];
  writeAscii(chunk, id);
  writeUint32(chunk, bodyBytes.length);
  chunk.push(...bodyBytes);
  return chunk;
}

/**
 * Builds a synthetic SMF Format 1 MIDI binary with tempo map, track names,
 * running status, two near-simultaneous chord notes, and a later note.
 */
function buildSyntheticFormat1Midi() {
  const headerBody = [];
  writeUint16(headerBody, 1); // Format 1
  writeUint16(headerBody, 2); // 2 tracks
  writeUint16(headerBody, 480); // 480 ticks per quarter
  const header = buildChunk("MThd", headerBody);

  // Track 0: Conductor / Tempo map (100 BPM at tick 0, 200 BPM at tick 960)
  const t0 = [];
  const t0Name = "Conductor";
  writeVLQ(t0, 0);
  t0.push(0xff, 0x03, t0Name.length);
  writeAscii(t0, t0Name);

  // 100 BPM = 600,000 us/quarter = 0x0927C0
  writeVLQ(t0, 0);
  t0.push(0xff, 0x51, 0x03, 0x09, 0x27, 0xc0);

  // At tick 960 (1200 ms): switch to 200 BPM = 300,000 us/quarter = 0x0493E0
  writeVLQ(t0, 960);
  t0.push(0xff, 0x51, 0x03, 0x04, 0x93, 0xe0);

  // End of track
  writeVLQ(t0, 0);
  t0.push(0xff, 0x2f, 0x00);

  // Track 1: Musical track
  const t1 = [];
  const t1Name = "Cathedral Strings";
  writeVLQ(t1, 0);
  t1.push(0xff, 0x03, t1Name.length);
  writeAscii(t1, t1Name);

  // Tick 0: Note On D4 (62), vel 100
  writeVLQ(t1, 0);
  t1.push(0x90, 62, 100);

  // Tick 12 (15 ms at 100 BPM, inside 45 ms chord window): Running status Note On F4 (65), vel 96
  writeVLQ(t1, 12);
  t1.push(65, 96);

  // Tick 480 (delta 468 -> 600 ms at 100 BPM): Note Off D4 (62) via 0x80
  writeVLQ(t1, 468);
  t1.push(0x80, 62, 0);

  // Tick 480 (delta 0): Note Off F4 (65) via Note On vel 0
  writeVLQ(t1, 0);
  t1.push(0x90, 65, 0);

  // Tick 960 (delta 480 -> 1200 ms): Note On A4 (69), vel 110
  writeVLQ(t1, 480);
  t1.push(0x90, 69, 110);

  // Tick 1440 (delta 480 at 200 BPM = +300 ms -> 1500 ms): Note Off A4 (69)
  writeVLQ(t1, 480);
  t1.push(0x80, 69, 0);

  // End of track
  writeVLQ(t1, 0);
  t1.push(0xff, 0x2f, 0x00);

  return new Uint8Array([
    ...header,
    ...buildChunk("MTrk", t0),
    ...buildChunk("MTrk", t1),
  ]);
}

function createMockAudioContext() {
  const calls = { ctorOpts: [], resumedSync: false, nodes: [], buffers: [] };

  const makeParam = (initial = 0) => ({
    value: initial,
    setValueAtTime(v) {
      this.value = v;
    },
    linearRampToValueAtTime(v) {
      this.value = v;
    },
    exponentialRampToValueAtTime(v) {
      this.value = v;
    },
    setTargetAtTime(v) {
      this.value = v;
    },
    cancelScheduledValues() {},
  });

  const makeNode = (kind) => ({
    kind,
    connected: [],
    connect(target) {
      this.connected.push(target);
      return target;
    },
    disconnect() {},
  });

  class MockAudioContext {
    constructor(opts) {
      calls.ctorOpts.push(opts);
      this.state = "suspended";
      this.sampleRate = 48000;
      this.currentTime = 1.0;
      this.destination = makeNode("destination");
    }

    resume() {
      calls.resumedSync = true;
      this.state = "running";
      return Promise.resolve();
    }

    createGain() {
      const node = { ...makeNode("gain"), gain: makeParam(1) };
      calls.nodes.push(node);
      return node;
    }

    createDynamicsCompressor() {
      const node = {
        ...makeNode("compressor"),
        threshold: makeParam(-24),
        knee: makeParam(30),
        ratio: makeParam(12),
        attack: makeParam(0.003),
        release: makeParam(0.25),
      };
      calls.nodes.push(node);
      return node;
    }

    createConvolver() {
      const node = { ...makeNode("convolver"), buffer: null };
      calls.nodes.push(node);
      return node;
    }

    createBiquadFilter() {
      const node = {
        ...makeNode("filter"),
        type: "lowpass",
        frequency: makeParam(1000),
        Q: makeParam(1),
      };
      calls.nodes.push(node);
      return node;
    }

    createOscillator() {
      const node = {
        ...makeNode("oscillator"),
        type: "sine",
        frequency: makeParam(440),
        detune: makeParam(0),
        startedAt: null,
        stoppedAt: null,
        onended: null,
        start(t) {
          this.startedAt = t;
        },
        stop(t) {
          this.stoppedAt = t;
        },
      };
      calls.nodes.push(node);
      return node;
    }

    createBufferSource() {
      const node = {
        ...makeNode("bufferSource"),
        buffer: null,
        onended: null,
        start() {},
        stop() {},
      };
      calls.nodes.push(node);
      return node;
    }

    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      const buf = {
        numberOfChannels: channels,
        length,
        sampleRate,
        getChannelData(c) {
          return data[c];
        },
      };
      calls.buffers.push(buf);
      return buf;
    }
  }

  return { MockAudioContext, calls };
}

test("ASHEN_CATHEDRAL_CUE defines 28 well-formed orchestral steps across 5 sections", () => {
  assert.equal(ASHEN_CATHEDRAL_CUE.title, "Ashen Cathedral (Original Cue)");
  assert.equal(ASHEN_CATHEDRAL_CUE.steps.length, 28);

  const validLayers = new Set([
    "bass",
    "strings",
    "brass",
    "choir",
    "timpani",
    "bell",
  ]);
  const sections = [];

  ASHEN_CATHEDRAL_CUE.steps.forEach((step, idx) => {
    assert.equal(step.index, idx);
    assert.ok(step.section.length > 0);
    assert.ok(step.label.length > 0);
    assert.ok(Array.isArray(step.notes) && step.notes.length > 0);
    assert.ok(validLayers.has(step.layer));
    assert.ok(step.durationSec > 0);
    assert.ok(step.gain > 0 && step.gain <= 1);
    for (const midi of step.notes) {
      assert.ok(Number.isInteger(midi) && midi >= 0 && midi <= 127);
    }
    if (sections[sections.length - 1] !== step.section) {
      sections.push(step.section);
    }
  });

  assert.deepEqual(sections, [
    "I. Ember",
    "II. Procession",
    "III. Choir of Cinders",
    "IV. Bell & Brass Climax",
    "V. Requiem",
  ]);
});

test("PlayAssistSequencer stays paused until advance(), supports stepBack/reset/loadScore and completion wrap", async () => {
  const seq = new PlayAssistSequencer();
  const initial = seq.getState();
  assert.equal(initial.title, "Ashen Cathedral (Original Cue)");
  assert.equal(initial.index, 0);
  assert.equal(initial.total, 28);
  assert.equal(initial.progress, 0);
  assert.equal(initial.currentStep, null);
  assert.equal(initial.nextStep.index, 0);
  assert.equal(initial.completed, false);

  // Sequencer must stay paused indefinitely without advance() calls.
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(seq.getState(), initial);

  const first = seq.advance(0.65);
  assert.equal(first.index, 0);
  assert.equal(first.step.index, 0);
  assert.equal(first.total, 28);
  assert.equal(first.completed, false);
  assert.equal(first.restarted, false);
  assert.equal(seq.getState().index, 1);
  assert.equal(seq.getState().currentStep.index, 0);
  assert.equal(seq.getState().nextStep.index, 1);

  const second = seq.advance(0.8);
  assert.equal(second.index, 1);
  assert.equal(seq.getState().index, 2);

  const backed = seq.stepBack();
  assert.equal(backed.index, 1);
  assert.equal(backed.nextStep.index, 1);

  seq.stepBack();
  seq.stepBack(); // clamping at 0 should be safe
  assert.equal(seq.getState().index, 0);
  assert.equal(seq.getState().currentStep, null);

  // Walk to completion (step 28 -> index 27)
  let last = null;
  for (let i = 0; i < 28; i++) {
    last = seq.advance(0.9);
  }
  assert.equal(last.index, 27);
  assert.equal(last.completed, true);
  assert.equal(last.progress, 1);
  assert.equal(seq.getState().completed, true);
  assert.equal(seq.getState().nextStep, null);

  // Tapping again after completion wraps cleanly back to step 0
  const wrapped = seq.advance(0.75);
  assert.equal(wrapped.index, 0);
  assert.equal(wrapped.restarted, true);
  assert.equal(wrapped.completed, false);
  assert.equal(seq.getState().index, 1);

  const resetState = seq.reset();
  assert.equal(resetState.index, 0);
  assert.equal(resetState.currentStep, null);
  assert.equal(resetState.completed, false);

  // loadScore accepts custom / MIDI-grouped score and resets cursor
  const custom = seq.loadScore({
    title: "Custom Ritual",
    source: "midi",
    steps: [
      { section: "Intro", label: "D4", notes: [62], layer: "strings" },
      { section: "Intro", label: "A4", notes: [69], layer: "bell" },
    ],
  });
  assert.equal(custom.title, "Custom Ritual");
  assert.equal(custom.total, 2);
  assert.equal(seq.advance().step.notes[0], 62);
  assert.equal(seq.advance().completed, true);

  assert.throws(() => seq.loadScore({ title: "Empty", steps: [] }));
});

test("parseMidiArrayBuffer parses SMF Format 1 with tempo map and groupTrackToAssistSteps groups chords", () => {
  const bytes = buildSyntheticFormat1Midi();
  const parsed = parseMidiArrayBuffer(bytes.buffer);

  assert.equal(parsed.format, 1);
  assert.equal(parsed.ticksPerQuarter, 480);
  assert.equal(parsed.tempoBpm, 100);
  assert.equal(parsed.tracks.length, 2);

  assert.equal(parsed.tracks[0].name, "Conductor");
  assert.equal(parsed.tracks[0].notes.length, 0);

  const track = parsed.tracks[1];
  assert.equal(track.name, "Cathedral Strings");
  assert.equal(track.notes.length, 3);

  assert.equal(track.notes[0].midi, 62);
  assert.equal(track.notes[0].timeMs, 0);
  assert.equal(track.notes[0].durationMs, 600);

  assert.equal(track.notes[1].midi, 65);
  assert.equal(track.notes[1].timeMs, 15);
  assert.equal(track.notes[1].durationMs, 585);

  // Tempo shifted to 200 BPM at tick 960 (1200 ms), so 480 ticks = 300 ms duration.
  assert.equal(track.notes[2].midi, 69);
  assert.equal(track.notes[2].timeMs, 1200);
  assert.equal(track.notes[2].durationMs, 300);

  const grouped = groupTrackToAssistSteps(track, {
    chordWindowMs: 45,
    title: "Synthetic Cathedral",
  });

  assert.equal(grouped.title, "Synthetic Cathedral");
  assert.equal(grouped.source, "midi");
  assert.equal(grouped.steps.length, 2);
  assert.deepEqual(grouped.steps[0].notes, [62, 65]);
  assert.equal(grouped.steps[0].layer, "strings");
  assert.deepEqual(grouped.steps[1].notes, [69]);

  // Verify compatibility with PlayAssistSequencer
  const seq = new PlayAssistSequencer(grouped);
  const s0 = seq.advance();
  const s1 = seq.advance();
  assert.deepEqual(s0.step.notes, [62, 65]);
  assert.deepEqual(s1.step.notes, [69]);
  assert.equal(s1.completed, true);

  assert.throws(() => parseMidiArrayBuffer(new Uint8Array([1, 2, 3, 4]).buffer));
});

test("parseMidiArrayBuffer supports SMF Format 0, default 120 BPM, and 1-byte program change events", () => {
  const headerBody = [];
  writeUint16(headerBody, 0); // Format 0
  writeUint16(headerBody, 1); // 1 track
  writeUint16(headerBody, 240); // 240 ticks/quarter (at default 120 BPM = 500 ms/quarter)

  const track = [];
  // Program Change ch 0 -> cello (42), 1 data byte
  writeVLQ(track, 0);
  track.push(0xc0, 42);
  // Note On D3 (50) at tick 0
  writeVLQ(track, 0);
  track.push(0x90, 50, 90);
  // Note Off D3 (50) at tick 240 (500 ms)
  writeVLQ(track, 240);
  track.push(0x80, 50, 0);
  // End of track
  writeVLQ(track, 0);
  track.push(0xff, 0x2f, 0x00);

  const smf0 = new Uint8Array([
    ...buildChunk("MThd", headerBody),
    ...buildChunk("MTrk", track),
  ]);
  const parsed = parseMidiArrayBuffer(smf0);
  assert.equal(parsed.format, 0);
  assert.equal(parsed.tempoBpm, 120);
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.tracks[0].name, "Track 1");
  assert.equal(parsed.tracks[0].notes.length, 1);
  assert.equal(parsed.tracks[0].notes[0].midi, 50);
  assert.equal(parsed.tracks[0].notes[0].timeMs, 0);
  assert.equal(parsed.tracks[0].notes[0].durationMs, 500);
});

test("RoomQuakeSynth is Node-safe and unlocks, voices Free Play & Assist steps, and caps polyphony", async () => {
  const nodeSynth = new RoomQuakeSynth();
  assert.equal(nodeSynth.getState(), "unsupported");
  assert.equal(await nodeSynth.unlock(), false);
  assert.equal(nodeSynth.playFreeHit(), null);
  assert.equal(nodeSynth.playAssistStep(ASHEN_CATHEDRAL_CUE.steps[0]), null);
  assert.equal(nodeSynth.playPrankCue(), null);

  const { MockAudioContext, calls } = createMockAudioContext();
  const prevAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = MockAudioContext;

  try {
    const synth = new RoomQuakeSynth({ maxVoices: 18 });
    assert.equal(synth.getState(), "locked");

    const unlockPromise = synth.unlock();
    assert.equal(calls.resumedSync, true);
    assert.deepEqual(calls.ctorOpts[0], { latencyHint: "interactive" });
    assert.equal(await unlockPromise, true);
    assert.equal(synth.getState(), "running");

    // Verify 2.4 s stereo hall IR was created
    assert.ok(calls.buffers.some((b) => b.numberOfChannels === 2 && b.length === 48000 * 2.4));

    synth.setMasterGain(0.8);
    synth.setReverbMix(0.4);

    const prank = synth.playPrankCue({ intensity: 0.8, spacingMs: 420 });
    assert.equal(prank.cue, "surprise");
    assert.equal(prank.notes.length, 8);
    assert.equal(prank.durationSec, 1.9);
    assert.ok(synth.activeVoices.length <= 18);

    // Free Play voices use only FREE_PLAY_POOL pitches and adapt spread to spacingMs
    const poolSet = new Set(FREE_PLAY_POOL);
    for (const voice of ["strings", "bells", "harp"]) {
      const rapid = synth.playFreeHit({ intensity: 0.4, spacingMs: 180, voice });
      const wide = synth.playFreeHit({ intensity: 0.9, spacingMs: 1100, voice });
      assert.ok(rapid.notes.length <= 2);
      assert.equal(wide.notes.length, 4);
      assert.ok(wide.releaseSec > rapid.releaseSec);
      assert.ok(wide.brightnessHz > rapid.brightnessHz);
      for (const n of [...rapid.notes, ...wide.notes]) {
        assert.ok(poolSet.has(n), `Unexpected pitch ${n} outside FREE_PLAY_POOL`);
      }
    }

    // Play all 28 cue steps (testing all 6 layers + extraLayers) & accentTimb
    for (const step of ASHEN_CATHEDRAL_CUE.steps) {
      const res = synth.playAssistStep(step, 0.85);
      assert.ok(res && res.layers.length >= 1);
      assert.ok(synth.activeVoices.length <= 18);
    }

    const timbRes = synth.playAssistStep(
      { notes: [50, 57], layer: "strings", accentTimb: true, durationSec: 1.5 },
      0.7,
    );
    assert.ok(timbRes.layers.includes("timpani"));
    assert.ok(synth.activeVoices.length <= 18);

    synth.stopAll();
    assert.equal(synth.activeVoices.length, 0);
  } finally {
    if (prevAudioContext === undefined) {
      delete globalThis.AudioContext;
    } else {
      globalThis.AudioContext = prevAudioContext;
    }
  }
});
