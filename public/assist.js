/**
 * Play Assist original orchestral cue and tap-driven step sequencer.
 * Pure JS module with zero DOM or Web Audio dependencies.
 */

const VALID_LAYERS = new Set([
  "bass",
  "strings",
  "brass",
  "choir",
  "timpani",
  "bell",
]);

function freezeStep(step, index) {
  const extraLayers = Array.isArray(step.extraLayers)
    ? Object.freeze(
        step.extraLayers.map((extra) =>
          Object.freeze({
            layer: VALID_LAYERS.has(extra.layer) ? extra.layer : "strings",
            notes: Object.freeze((extra.notes || step.notes).slice()),
            gain: extra.gain,
            durationSec: extra.durationSec,
          }),
        ),
      )
    : undefined;

  const normalized = {
    index,
    section: String(step.section || "Cue"),
    label: String(step.label || `Step ${index + 1}`),
    notes: Object.freeze(step.notes.slice()),
    layer: VALID_LAYERS.has(step.layer) ? step.layer : "strings",
    durationSec: Number.isFinite(step.durationSec) ? step.durationSec : 1.8,
    gain: Number.isFinite(step.gain) ? step.gain : 0.78,
  };

  if (extraLayers && extraLayers.length > 0) {
    normalized.extraLayers = extraLayers;
  }
  if (step.accentTimb) {
    normalized.accentTimb = true;
  }
  if (Number.isFinite(step.timeMs)) {
    normalized.timeMs = step.timeMs;
  }
  return Object.freeze(normalized);
}

const RAW_ASHEN_STEPS = [
  // I. Ember (Steps 1-4)
  {
    section: "I. Ember",
    label: "Low D Drone",
    notes: [38, 45, 50],
    layer: "bass",
    durationSec: 2.2,
    gain: 0.65,
  },
  {
    section: "I. Ember",
    label: "Suspended Fifth",
    notes: [38, 45, 52],
    layer: "bass",
    durationSec: 2.0,
    gain: 0.68,
  },
  {
    section: "I. Ember",
    label: "Minor Third Awakening",
    notes: [38, 45, 53],
    layer: "bass",
    extraLayers: [{ layer: "strings", notes: [50, 53, 57], gain: 0.38 }],
    durationSec: 2.0,
    gain: 0.7,
  },
  {
    section: "I. Ember",
    label: "Cathedral Open Fifth",
    notes: [38, 45, 57, 64],
    layer: "bass",
    extraLayers: [{ layer: "strings", notes: [57, 64], gain: 0.42 }],
    durationSec: 2.2,
    gain: 0.72,
  },

  // II. Procession (Steps 5-10)
  {
    section: "II. Procession",
    label: "Dm — Solemn March",
    notes: [50, 53, 57, 62],
    layer: "strings",
    extraLayers: [{ layer: "bass", notes: [38, 45], gain: 0.55 }],
    durationSec: 1.9,
    gain: 0.74,
  },
  {
    section: "II. Procession",
    label: "Bbmaj7 — Dark Horizon",
    notes: [46, 53, 57, 62, 65],
    layer: "strings",
    extraLayers: [{ layer: "brass", notes: [46, 58], gain: 0.45 }],
    durationSec: 1.9,
    gain: 0.76,
  },
  {
    section: "II. Procession",
    label: "Gm7 — Heavy Tread",
    notes: [43, 50, 53, 58, 62],
    layer: "strings",
    extraLayers: [{ layer: "brass", notes: [43, 55], gain: 0.48 }],
    durationSec: 1.8,
    gain: 0.78,
  },
  {
    section: "II. Procession",
    label: "Eb/G — Phrygian Shadow",
    notes: [43, 51, 55, 58, 63],
    layer: "strings",
    extraLayers: [{ layer: "brass", notes: [39, 51], gain: 0.52 }],
    durationSec: 2.0,
    gain: 0.8,
  },
  {
    section: "II. Procession",
    label: "Asus4 — Gathering Breath",
    notes: [45, 52, 57, 62, 64],
    layer: "brass",
    extraLayers: [{ layer: "strings", notes: [52, 57, 62], gain: 0.65 }],
    durationSec: 1.8,
    gain: 0.82,
  },
  {
    section: "II. Procession",
    label: "A7 — Dominant Tension",
    notes: [45, 52, 55, 61, 64],
    layer: "brass",
    extraLayers: [
      { layer: "strings", notes: [55, 61, 64], gain: 0.65 },
      { layer: "timpani", notes: [33], gain: 0.55 },
    ],
    durationSec: 2.1,
    gain: 0.84,
  },

  // III. Choir of Cinders (Steps 11-18)
  {
    section: "III. Choir of Cinders",
    label: "D — First Litany",
    notes: [50, 57, 62, 65],
    layer: "choir",
    extraLayers: [
      { layer: "strings", notes: [38, 50, 62], gain: 0.58 },
      { layer: "timpani", notes: [38], gain: 0.68 },
    ],
    durationSec: 1.8,
    gain: 0.82,
  },
  {
    section: "III. Choir of Cinders",
    label: "Bb — Rising Sixth",
    notes: [50, 58, 65, 70],
    layer: "choir",
    extraLayers: [{ layer: "strings", notes: [46, 58, 70], gain: 0.6 }],
    durationSec: 1.7,
    gain: 0.84,
  },
  {
    section: "III. Choir of Cinders",
    label: "A — Cinder Sigh",
    notes: [45, 53, 57, 69],
    layer: "choir",
    extraLayers: [{ layer: "strings", notes: [45, 57, 69], gain: 0.58 }],
    durationSec: 1.8,
    gain: 0.82,
  },
  {
    section: "III. Choir of Cinders",
    label: "Gm/Bb — Nave Echo",
    notes: [46, 55, 58, 67],
    layer: "choir",
    extraLayers: [
      { layer: "brass", notes: [46, 58], gain: 0.52 },
      { layer: "timpani", notes: [43], gain: 0.62 },
    ],
    durationSec: 1.8,
    gain: 0.85,
  },
  {
    section: "III. Choir of Cinders",
    label: "Dm/F — High Vault",
    notes: [53, 57, 62, 74],
    layer: "choir",
    extraLayers: [{ layer: "strings", notes: [41, 53, 62, 74], gain: 0.66 }],
    durationSec: 1.7,
    gain: 0.86,
  },
  {
    section: "III. Choir of Cinders",
    label: "Bbadd9 — Ascending Flame",
    notes: [46, 53, 60, 70],
    layer: "choir",
    extraLayers: [
      { layer: "brass", notes: [46, 58, 70], gain: 0.58 },
      { layer: "timpani", notes: [38], gain: 0.72 },
    ],
    durationSec: 1.8,
    gain: 0.88,
  },
  {
    section: "III. Choir of Cinders",
    label: "A7sus4 — Choir Hold",
    notes: [45, 52, 57, 62, 69],
    layer: "choir",
    extraLayers: [{ layer: "brass", notes: [45, 57, 69], gain: 0.62 }],
    durationSec: 1.7,
    gain: 0.9,
  },
  {
    section: "III. Choir of Cinders",
    label: "A7(b9) — Altar Threshold",
    notes: [45, 52, 55, 61, 70],
    layer: "choir",
    extraLayers: [
      { layer: "brass", notes: [45, 55, 61], gain: 0.68 },
      { layer: "timpani", notes: [33], gain: 0.78 },
    ],
    durationSec: 1.9,
    gain: 0.92,
  },

  // IV. Bell & Brass Climax (Steps 19-24)
  {
    section: "IV. Bell & Brass Climax",
    label: "Dm — Cathedral Strike",
    notes: [50, 57, 62, 65, 74],
    layer: "brass",
    extraLayers: [
      { layer: "strings", notes: [38, 50, 62, 74], gain: 0.82 },
      { layer: "choir", notes: [57, 62, 65], gain: 0.72 },
      { layer: "bell", notes: [62, 74], gain: 0.75 },
      { layer: "timpani", notes: [38], gain: 0.92 },
    ],
    durationSec: 2.0,
    gain: 0.96,
  },
  {
    section: "IV. Bell & Brass Climax",
    label: "Ebmaj7 — Phrygian Blaze",
    notes: [39, 51, 58, 62, 67],
    layer: "brass",
    extraLayers: [
      { layer: "strings", notes: [51, 58, 62, 75], gain: 0.84 },
      { layer: "choir", notes: [55, 62, 67], gain: 0.75 },
      { layer: "bell", notes: [63, 75], gain: 0.78 },
    ],
    durationSec: 2.0,
    gain: 0.98,
  },
  {
    section: "IV. Bell & Brass Climax",
    label: "C/E — Iron Processional",
    notes: [40, 52, 60, 67, 72],
    layer: "brass",
    extraLayers: [
      { layer: "strings", notes: [48, 60, 67, 76], gain: 0.84 },
      { layer: "choir", notes: [60, 64, 72], gain: 0.76 },
      { layer: "bell", notes: [60, 72], gain: 0.78 },
      { layer: "timpani", notes: [40], gain: 0.88 },
    ],
    durationSec: 1.9,
    gain: 0.98,
  },
  {
    section: "IV. Bell & Brass Climax",
    label: "Bbmaj7#11 — Crown of Ash",
    notes: [46, 53, 62, 69, 76],
    layer: "brass",
    extraLayers: [
      { layer: "strings", notes: [46, 58, 69, 76], gain: 0.85 },
      { layer: "choir", notes: [58, 64, 69], gain: 0.78 },
      { layer: "bell", notes: [69, 81], gain: 0.8 },
    ],
    durationSec: 2.0,
    gain: 1.0,
  },
  {
    section: "IV. Bell & Brass Climax",
    label: "A7sus4 — Toll of the Bell",
    notes: [45, 52, 57, 62, 67],
    layer: "brass",
    extraLayers: [
      { layer: "strings", notes: [45, 57, 62, 74], gain: 0.84 },
      { layer: "choir", notes: [57, 62, 67], gain: 0.78 },
      { layer: "bell", notes: [62, 74], gain: 0.82 },
      { layer: "timpani", notes: [33], gain: 0.94 },
    ],
    durationSec: 2.1,
    gain: 1.0,
  },
  {
    section: "IV. Bell & Brass Climax",
    label: "A7 — Final Vow",
    notes: [45, 52, 55, 61, 69],
    layer: "brass",
    extraLayers: [
      { layer: "strings", notes: [45, 55, 61, 73], gain: 0.84 },
      { layer: "choir", notes: [55, 61, 69], gain: 0.78 },
      { layer: "bell", notes: [69, 81], gain: 0.84 },
    ],
    durationSec: 2.2,
    gain: 1.0,
  },

  // V. Requiem (Steps 25-28)
  {
    section: "V. Requiem",
    label: "Dm — Monumental Resolution",
    notes: [38, 50, 57, 62, 65],
    layer: "strings",
    extraLayers: [
      { layer: "brass", notes: [38, 50, 57], gain: 0.72 },
      { layer: "choir", notes: [50, 57, 65], gain: 0.7 },
      { layer: "bell", notes: [62, 74], gain: 0.76 },
      { layer: "timpani", notes: [38], gain: 0.9 },
    ],
    durationSec: 2.6,
    gain: 0.92,
  },
  {
    section: "V. Requiem",
    label: "Dm/A — Embers Settle",
    notes: [45, 50, 57, 65],
    layer: "strings",
    extraLayers: [{ layer: "choir", notes: [53, 57, 62], gain: 0.56 }],
    durationSec: 2.5,
    gain: 0.76,
  },
  {
    section: "V. Requiem",
    label: "Dm9 — Silent Nave",
    notes: [38, 50, 57, 64],
    layer: "choir",
    extraLayers: [{ layer: "strings", notes: [50, 57, 64, 69], gain: 0.5 }],
    durationSec: 2.8,
    gain: 0.64,
  },
  {
    section: "V. Requiem",
    label: "D9 — Cathedral Fade",
    notes: [38, 50, 57, 64, 69],
    layer: "strings",
    extraLayers: [
      { layer: "bell", notes: [64, 69, 74], gain: 0.45 },
      { layer: "choir", notes: [50, 64, 69], gain: 0.42 },
    ],
    durationSec: 3.4,
    gain: 0.54,
  },
];

export const ASHEN_CATHEDRAL_CUE = Object.freeze({
  title: "Ashen Cathedral (Original Cue)",
  source: "builtin",
  key: "D minor / Phrygian",
  steps: Object.freeze(RAW_ASHEN_STEPS.map((step, i) => freezeStep(step, i))),
});

export class PlayAssistSequencer {
  constructor(score = ASHEN_CATHEDRAL_CUE) {
    this.title = "";
    this.source = "builtin";
    this.steps = [];
    this.cursor = 0;
    this.completed = false;
    this.loadScore(score);
  }

  loadScore(score) {
    const rawSteps = Array.isArray(score) ? score : score?.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      throw new Error("PlayAssistSequencer score must contain at least one step.");
    }

    const normalizedSteps = rawSteps.map((step, i) => {
      if (!step || !Array.isArray(step.notes) || step.notes.length === 0) {
        throw new Error(`Invalid Play Assist step at index ${i}.`);
      }
      return freezeStep(step, i);
    });

    this.title = Array.isArray(score)
      ? "Custom Score"
      : String(score.title || "Untitled Cue");
    this.source = Array.isArray(score)
      ? "custom"
      : String(score.source || "custom");
    this.steps = normalizedSteps;
    this.cursor = 0;
    this.completed = false;
    return this.getState();
  }

  /**
   * Advances one step on user confirmation; wraps smoothly to step 0 if already completed.
   */
  advance(intensity = 0.7) {
    const total = this.steps.length;
    let restarted = false;

    if (this.completed || this.cursor >= total) {
      this.cursor = 0;
      this.completed = false;
      restarted = true;
    }

    const stepIndex = this.cursor;
    const step = this.steps[stepIndex];
    this.cursor = stepIndex + 1;
    this.completed = this.cursor >= total;
    const progress = total > 0 ? this.cursor / total : 0;

    return {
      step,
      index: stepIndex,
      total,
      progress,
      completed: this.completed,
      restarted,
      intensity: Number.isFinite(intensity)
        ? Math.min(1, Math.max(0, intensity))
        : 0.7,
    };
  }

  stepBack() {
    if (this.cursor > 0) {
      this.cursor -= 1;
      this.completed = false;
    }
    return this.getState();
  }

  reset() {
    this.cursor = 0;
    this.completed = false;
    return this.getState();
  }

  getState() {
    const total = this.steps.length;
    return {
      title: this.title,
      source: this.source,
      index: this.cursor,
      total,
      progress: total > 0 ? this.cursor / total : 0,
      currentStep: this.cursor > 0 ? this.steps[this.cursor - 1] : null,
      nextStep: this.cursor < total ? this.steps[this.cursor] : null,
      completed: this.completed,
    };
  }
}
