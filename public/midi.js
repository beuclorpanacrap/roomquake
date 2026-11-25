/**
 * Pure JS zero-dependency Standard MIDI File (SMF Format 0 & 1) parser
 * and chord-grouping adapter for RoomQuake Play Assist.
 */

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
];

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

export function midiToNoteName(midi) {
  const safe = Math.max(0, Math.min(127, Math.round(midi)));
  const octave = Math.floor(safe / 12) - 1;
  return `${NOTE_NAMES[safe % 12]}${octave}`;
}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  remaining() {
    return this.bytes.length - this.pos;
  }

  ensure(count) {
    if (this.pos + count > this.bytes.length) {
      throw new Error("Unexpected end of MIDI data.");
    }
  }

  readUint8() {
    this.ensure(1);
    return this.bytes[this.pos++];
  }

  readUint16() {
    this.ensure(2);
    const val = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1];
    this.pos += 2;
    return val;
  }

  readUint32() {
    this.ensure(4);
    const val =
      ((this.bytes[this.pos] << 24) |
        (this.bytes[this.pos + 1] << 16) |
        (this.bytes[this.pos + 2] << 8) |
        this.bytes[this.pos + 3]) >>>
      0;
    this.pos += 4;
    return val;
  }

  readAscii(length) {
    this.ensure(length);
    let out = "";
    for (let i = 0; i < length; i++) {
      out += String.fromCharCode(this.bytes[this.pos + i]);
    }
    this.pos += length;
    return out;
  }

  readSlice(length) {
    this.ensure(length);
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  readVLQ() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.readUint8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("Invalid MIDI variable-length quantity.");
  }
}

function buildTempoSegments(tempoEvents, ticksPerQuarter, smpteTicksPerSec) {
  if (smpteTicksPerSec) {
    return [{ tick: 0, msPerTick: 1000 / smpteTicksPerSec, startMs: 0 }];
  }

  const sorted = tempoEvents
    .slice()
    .sort((a, b) => a.tick - b.tick || a.order - b.order);

  const deduped = [];
  for (const ev of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].tick === ev.tick) {
      deduped[deduped.length - 1] = ev;
    } else {
      deduped.push(ev);
    }
  }

  if (deduped.length === 0 || deduped[0].tick > 0) {
    deduped.unshift({ tick: 0, usPerQuarter: 500000, order: -1 });
  }

  const segments = [];
  let currentMs = 0;
  for (let i = 0; i < deduped.length; i++) {
    const ev = deduped[i];
    if (i > 0) {
      const prev = segments[i - 1];
      currentMs += (ev.tick - prev.tick) * prev.msPerTick;
    }
    segments.push({
      tick: ev.tick,
      usPerQuarter: ev.usPerQuarter,
      msPerTick: ev.usPerQuarter / 1000 / ticksPerQuarter,
      startMs: currentMs,
    });
  }
  return segments;
}

function ticksToMs(tick, segments) {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  const seg = segments[lo];
  return seg.startMs + (tick - seg.tick) * seg.msPerTick;
}

function parseTrackChunk(trackBytes, trackIndex, ticksPerQuarter, tempoEvents, decoder) {
  const reader = new ByteReader(trackBytes);
  const openNotes = new Map();
  const rawNotes = [];
  let absTicks = 0;
  let runningStatus = 0;
  let trackName = "";
  let orderCounter = tempoEvents.length;

  const closeNote = (key, endTick) => {
    const stack = openNotes.get(key);
    if (!stack || stack.length === 0) return;
    const open = stack.shift();
    rawNotes.push({
      midi: open.midi,
      startTick: open.startTick,
      endTick: Math.max(open.startTick + 1, endTick),
      velocity: open.velocity,
    });
  };

  while (reader.remaining() > 0) {
    const deltaTicks = reader.readVLQ();
    absTicks += deltaTicks;

    const firstByte = reader.readUint8();
    let status;
    let firstDataByte = null;

    if (firstByte >= 0x80) {
      status = firstByte;
      if (status < 0xf0) {
        runningStatus = status;
      } else if (status === 0xf0 || status === 0xf7 || status === 0xff) {
        runningStatus = 0;
      }
    } else {
      if (!runningStatus) {
        throw new Error(`Invalid MIDI running status in track ${trackIndex}.`);
      }
      status = runningStatus;
      firstDataByte = firstByte;
    }

    if (status === 0xff) {
      const metaType = reader.readUint8();
      const metaLen = reader.readVLQ();
      const payload = reader.readSlice(metaLen);

      if (metaType === 0x03) {
        trackName = decoder.decode(payload).replace(/\0+$/g, "").trim();
      } else if (metaType === 0x51 && payload.length === 3) {
        const usPerQuarter =
          (payload[0] << 16) | (payload[1] << 8) | payload[2];
        if (usPerQuarter > 0) {
          tempoEvents.push({
            tick: absTicks,
            usPerQuarter,
            order: orderCounter++,
          });
        }
      } else if (metaType === 0x2f) {
        break;
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const sysexLen = reader.readVLQ();
      reader.readSlice(sysexLen);
      continue;
    }

    const eventType = status & 0xf0;
    const channel = status & 0x0f;
    const data1 = firstDataByte !== null ? firstDataByte : reader.readUint8();

    // Program Change (0xC0) and Channel Pressure (0xD0) carry only one data byte.
    if (eventType === 0xc0 || eventType === 0xd0) {
      continue;
    }

    const data2 = reader.readUint8();
    if (eventType === 0x90) {
      const key = `${channel}:${data1}`;
      if (data2 > 0) {
        let stack = openNotes.get(key);
        if (!stack) {
          stack = [];
          openNotes.set(key, stack);
        }
        stack.push({
          midi: data1 & 0x7f,
          velocity: clamp(data2 / 127, 0.01, 1),
          startTick: absTicks,
        });
      } else {
        closeNote(key, absTicks);
      }
    } else if (eventType === 0x80) {
      closeNote(`${channel}:${data1}`, absTicks);
    }
  }

  // Close any dangling notes cleanly at end of track.
  const fallbackSpan = Math.max(1, Math.round(ticksPerQuarter / 4));
  for (const stack of openNotes.values()) {
    for (const open of stack) {
      rawNotes.push({
        midi: open.midi,
        startTick: open.startTick,
        endTick: Math.max(absTicks, open.startTick + fallbackSpan),
        velocity: open.velocity,
      });
    }
  }

  return {
    index: trackIndex,
    name: trackName || `Track ${trackIndex + 1}`,
    rawNotes,
  };
}

/**
 * Parses a Standard MIDI File (Format 0 or Format 1) ArrayBuffer or TypedArray.
 */
export function parseMidiArrayBuffer(arrayBuffer) {
  let bytes;
  if (arrayBuffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(arrayBuffer);
  } else if (ArrayBuffer.isView(arrayBuffer)) {
    bytes = new Uint8Array(
      arrayBuffer.buffer,
      arrayBuffer.byteOffset,
      arrayBuffer.byteLength,
    );
  } else {
    throw new TypeError("Expected an ArrayBuffer or TypedArray containing MIDI data.");
  }

  const reader = new ByteReader(bytes);
  const headerId = reader.readAscii(4);
  if (headerId !== "MThd") {
    throw new Error("Invalid MIDI file: missing MThd header chunk.");
  }

  const headerLength = reader.readUint32();
  if (headerLength < 6) {
    throw new Error("Invalid MIDI header length.");
  }

  const format = reader.readUint16();
  if (format > 2) {
    throw new Error(`Unsupported MIDI format ${format}.`);
  }

  const expectedTracks = reader.readUint16();
  const division = reader.readUint16();
  if (headerLength > 6) {
    reader.readSlice(headerLength - 6);
  }

  let ticksPerQuarter = 480;
  let smpteTicksPerSec = null;
  if ((division & 0x8000) === 0) {
    ticksPerQuarter = division || 480;
  } else {
    const negFps = (division >> 8) & 0xff;
    const fps = 256 - negFps;
    const ticksPerFrame = division & 0xff;
    smpteTicksPerSec = Math.max(1, fps * ticksPerFrame);
  }

  const decoder = new TextDecoder("utf-8");
  const tempoEvents = [];
  const rawTracks = [];

  while (reader.remaining() >= 8 && rawTracks.length < expectedTracks) {
    const chunkId = reader.readAscii(4);
    const chunkLength = reader.readUint32();
    const chunkBytes = reader.readSlice(chunkLength);

    if (chunkId === "MTrk") {
      rawTracks.push(
        parseTrackChunk(
          chunkBytes,
          rawTracks.length,
          ticksPerQuarter,
          tempoEvents,
          decoder,
        ),
      );
    }
  }

  if (rawTracks.length === 0) {
    throw new Error("MIDI file contains no MTrk track chunks.");
  }

  const segments = buildTempoSegments(tempoEvents, ticksPerQuarter, smpteTicksPerSec);
  const initialUsPerQuarter =
    tempoEvents.length > 0
      ? tempoEvents.slice().sort((a, b) => a.tick - b.tick || a.order - b.order)[0]
          .usPerQuarter
      : 500000;
  const tempoBpm = Math.round((60000000 / initialUsPerQuarter) * 100) / 100;

  const tracks = rawTracks.map((track) => {
    const notes = track.rawNotes
      .map((note) => {
        const startMs = ticksToMs(note.startTick, segments);
        const endMs = ticksToMs(note.endTick, segments);
        return {
          midi: note.midi,
          timeMs: roundMs(startMs),
          durationMs: roundMs(Math.max(10, endMs - startMs)),
          velocity: Math.round(note.velocity * 1000) / 1000,
        };
      })
      .sort((a, b) => a.timeMs - b.timeMs || a.midi - b.midi);

    return {
      index: track.index,
      name: track.name,
      notes,
    };
  });

  return {
    format,
    ticksPerQuarter,
    tempoBpm,
    tracks,
  };
}

/**
 * Groups simultaneous / near-simultaneous notes from a parsed MIDI track
 * into chord steps compatible with PlayAssistSequencer.loadScore().
 */
export function groupTrackToAssistSteps(
  track,
  { chordWindowMs = 45, maxSteps = 256, title = "Imported MIDI" } = {},
) {
  const rawNotes = Array.isArray(track) ? track : track?.notes || [];
  const trackName = !Array.isArray(track) && track?.name ? String(track.name) : title;

  const sortedNotes = rawNotes
    .filter(
      (n) =>
        n &&
        Number.isFinite(n.midi) &&
        n.midi >= 0 &&
        n.midi <= 127 &&
        Number.isFinite(n.timeMs) &&
        n.timeMs >= 0,
    )
    .slice()
    .sort((a, b) => a.timeMs - b.timeMs || a.midi - b.midi);

  const windowMs = Math.max(0, Number.isFinite(chordWindowMs) ? chordWindowMs : 45);
  const limit = Math.max(1, Math.floor(maxSteps));

  const groups = [];
  for (const note of sortedNotes) {
    const activeGroup = groups[groups.length - 1];
    if (activeGroup && note.timeMs - activeGroup[0].timeMs <= windowMs) {
      activeGroup.push(note);
    } else {
      if (groups.length >= limit) break;
      groups.push([note]);
    }
  }

  const steps = groups.map((group, index) => {
    const uniqueMidis = [...new Set(group.map((n) => Math.round(n.midi)))].sort(
      (a, b) => a - b,
    );
    const maxDurationMs = Math.max(
      ...group.map((n) => (Number.isFinite(n.durationMs) ? n.durationMs : 600)),
    );
    const avgVelocity =
      group.reduce(
        (acc, n) => acc + (Number.isFinite(n.velocity) ? clamp(n.velocity, 0.05, 1) : 0.7),
        0,
      ) / group.length;

    return {
      index,
      section: trackName,
      label: uniqueMidis.slice(0, 4).map(midiToNoteName).join(" · "),
      notes: uniqueMidis,
      layer: "strings",
      durationSec: Math.round(clamp(maxDurationMs / 1000, 0.45, 4.0) * 100) / 100,
      gain: Math.round(clamp(0.42 + avgVelocity * 0.48, 0.35, 0.95) * 100) / 100,
      timeMs: roundMs(group[0].timeMs),
    };
  });

  return {
    title: String(title || trackName || "Imported MIDI"),
    source: "midi",
    trackName,
    steps,
  };
}
