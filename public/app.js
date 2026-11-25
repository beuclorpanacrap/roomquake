import { estimateClock } from "/lib/signal.js";
import { renderQrSvg } from "/lib/qr.js";
import { createFlatStillTracker } from "./onboarding.js";
import { RoomQuakeSynth } from "./synth.js";
import { ASHEN_CATHEDRAL_CUE, PlayAssistSequencer } from "./assist.js";
import { parseMidiArrayBuffer, groupTrackToAssistSteps } from "./midi.js";
import { ProjectorStage } from "./projector.js";
import { AcousticExperimentClient } from "./acoustics-client.js";

const $ = (id) => document.getElementById(id),
  escape = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

let ws,
  role = null,
  code = null,
  credential = null,
  selfDeviceId = null,
  state = null,
  sensing = false,
  motionAuthorized = false,
  wantAutoStart = false,
  batch = [],
  clockSamples = [],
  clock = null,
  reconnectTimer,
  noMotionTimer,
  lastMotion = 0,
  joined = false;

let framePending = false,
  layoutKey = "",
  eventsKey = "",
  qrKey = "",
  mode = "performance",
  lastPaint = 0;

let instrumentMode = "free",
  freeVoice = "strings",
  auditionSim = false,
  projectorOpen = false,
  qrPinned = null,
  lastHitAudioAt = 0,
  lastCalProgressAt = 0,
  parsedMidi = null;

const playedEventIds = new Set();
const PLAYED_EVENT_LIMIT = 200;

const tracker = createFlatStillTracker();
const synth = new RoomQuakeSynth();
const assist = new PlayAssistSequencer(ASHEN_CATHEDRAL_CUE);
const projector = new ProjectorStage({
  canvas: $("projectorCanvas"),
  traceCanvas: $("projectorTraces"),
});
let acousticClient = null;
let micActive = false;

const send = (m) => {
  if (ws?.readyState === WebSocket.OPEN && (ws.bufferedAmount || 0) < 65536) {
    ws.send(JSON.stringify(m));
    return true;
  }
  return false;
};

const scheduleRender = () => {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame((frameTime) => {
    framePending = false;
    render(frameTime);
    lastPaint = performance.now();
  });
};

const notice = (s) => {
  const el = $("notice");
  if (el) el.textContent = s;
};

function recordPlayedId(id) {
  if (!id) return;
  playedEventIds.add(id);
  if (playedEventIds.size > PLAYED_EVENT_LIMIT) {
    const oldest = playedEventIds.values().next().value;
    playedEventIds.delete(oldest);
  }
}

function isEventFresh(event) {
  const nowServer = Date.now() + (clock?.offset || 0);
  const ref = Number.isFinite(event?.serverEmittedAt)
    ? event.serverEmittedAt
    : event?.time;
  return Number.isFinite(ref) && Math.abs(nowServer - ref) <= 1500;
}

function canPlayEvent(event) {
  if (!event?.id || playedEventIds.has(event.id)) return false;
  if (!isEventFresh(event)) return false;
  if (event.origin === "simulated" || event.origin === "mixed") {
    return auditionSim;
  }
  return true;
}

function upsertEvent(event) {
  if (!event || !state) return;
  const idx = state.events.findIndex((e) => e.id === event.id);
  if (idx >= 0) {
    state.events[idx] = { ...state.events[idx], ...event };
  } else {
    state.events.unshift(event);
  }
  state.events.sort((a, b) => b.time - a.time);
  state.events = state.events.slice(0, 40);
}

function updateAudioUi() {
  const st = synth.getState();
  const ready = st === "running";
  const badge = $("audioStateBadge");
  if (badge) {
    badge.textContent =
      st === "unsupported"
        ? "NO WEB AUDIO"
        : ready
          ? "AUDIO READY"
          : "AUDIO LOCKED";
  }
  const btn = $("unlockAudio");
  if (btn) btn.textContent = ready ? "Audio Ready" : "Enable Audio";
  const projBtn = $("projAudioBtn");
  if (projBtn) {
    projBtn.textContent = ready ? "● Audio Ready" : "Enable Audio";
    projBtn.classList?.toggle?.("is-ready", ready);
  }
}

async function ensureAudioUnlocked() {
  const ok = await synth.unlock();
  updateAudioUi();
  return ok;
}

function updateAssistUi() {
  const st = assist.getState();
  const pct = `${Math.round(st.progress * 100)}%`;
  const assistBar = $("assistBar");
  if (assistBar) assistBar.hidden = instrumentMode !== "assist";
  const freeVoiceWrap = $("freeVoiceWrap");
  if (freeVoiceWrap) freeVoiceWrap.hidden = instrumentMode === "assist";
  const projAssistReset = $("projAssistReset");
  if (projAssistReset) projAssistReset.hidden = instrumentMode !== "assist";

  if ($("assistTitle")) $("assistTitle").textContent = st.title;
  if ($("assistSection")) {
    $("assistSection").textContent =
      st.currentStep?.section || st.nextStep?.section || "READY";
  }
  if ($("assistLabel")) {
    $("assistLabel").textContent = st.completed
      ? `Completed (${st.total} steps) — tap to restart`
      : st.nextStep
        ? `Next: ${st.nextStep.label}`
        : "Ready";
  }
  if ($("assistCount")) {
    $("assistCount").textContent =
      `${String(st.index).padStart(2, "0")} / ${String(st.total).padStart(2, "0")}`;
  }
  if ($("assistProgressFill")?.style) {
    $("assistProgressFill").style.width = pct;
  }
  if ($("projCueText")) {
    if (instrumentMode === "assist") {
      const label = st.currentStep
        ? `${st.currentStep.section} · ${st.currentStep.label}`
        : `Ready · ${st.nextStep?.label || st.title}`;
      $("projCueText").textContent = `${label} [${st.index}/${st.total}]`;
    } else {
      const voiceLabel =
        freeVoice === "bells"
          ? "Glassy Bells"
          : freeVoice === "harp"
            ? "Resonant Harp"
            : "Soft Strings";
      $("projCueText").textContent = `Free Play · ${voiceLabel}`;
    }
  }
  if ($("projCueFill")?.style) {
    $("projCueFill").style.width = instrumentMode === "assist" ? pct : "100%";
  }
}

function triggerPerformanceOutput(event) {
  const nowPerf = performance.now();
  const spacingMs = lastHitAudioAt > 0 ? nowPerf - lastHitAudioAt : 1200;
  lastHitAudioAt = nowPerf;
  const intensity = Number.isFinite(event.intensity)
    ? event.intensity
    : Math.min(1, Math.max(0.08, ((event.peak || 1) - 0.16) / 2.5));

  let decaySec = 2.4;
  if (instrumentMode === "assist") {
    const adv = assist.advance(intensity);
    synth.playAssistStep(adv.step, intensity);
    decaySec = Math.max(1.2, adv.step?.durationSec || 2.0);
    updateAssistUi();
  } else {
    const res = synth.playFreeHit({ intensity, spacingMs, voice: freeVoice });
    decaySec = res?.releaseSec || 2.4;
  }
  projector.triggerRipple(event, decaySec);
}

function joinUrlFor(roomCode) {
  const url = new URL(location.href);
  url.search = `?room=${roomCode}`;
  url.hash = "";
  return url.href;
}

function refreshQrDisplays() {
  if (!code || role !== "host") return;
  const url = joinUrlFor(code);
  if (qrKey === url) return;
  qrKey = url;
  try {
    const svgSmall = renderQrSvg(url, { size: 128, margin: 2 });
    const svgLarge = renderQrSvg(url, { size: 210, margin: 2 });
    if ($("labQrSvg")) $("labQrSvg").innerHTML = svgSmall;
    if ($("projQrSvg")) $("projQrSvg").innerHTML = svgLarge;
  } catch {
    // Keep functional code display if URL exceeds QR max capacity
  }
  if ($("projQrCode")) $("projQrCode").textContent = code;
  if ($("projQrUrl")) $("projQrUrl").textContent = url;
  const isLocal =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const warn = $("projQrWarning");
  if (warn) {
    warn.hidden = !isLocal;
    warn.textContent = isLocal
      ? "Host opened on localhost — reopen via trusted LAN HTTPS IP or tunnel URL so phones can reach this room."
      : "";
  }
}

function updatePhonePhaseUi(status) {
  const card = $("phoneStateCard");
  const badge = $("phonePhaseBadge");
  const title = $("phonePhaseTitle");
  const tilt = $("phoneTiltInfo");
  const fill = $("phoneCalProgress");
  const icon = $("phoneStepIcon");

  const map = {
    place_flat: {
      badge: "PLACE FLAT",
      title: "Place phone flat on the table",
      icon: "01",
    },
    calibrating: {
      badge: "CALIBRATING",
      title: "Calibrating… hold steady",
      icon: "02",
    },
    ready: {
      badge: "READY",
      title: "Ready — tap the table gently",
      icon: "✓",
    },
    moved: {
      badge: "MOVED",
      title: "Phone moved — set flat to resume",
      icon: "!",
    },
    paused: {
      badge: "PAUSED",
      title: "Motion paused",
      icon: "○",
    },
  };
  const info = map[status.state] || map.place_flat;
  if (card?.setAttribute) card.setAttribute("data-state", status.state);
  if (badge) badge.textContent = info.badge;
  if (title) title.textContent = info.title;
  if (icon) icon.textContent = info.icon;
  if (tilt) {
    const deg = Number.isFinite(status.tiltDeg)
      ? `${Math.round(status.tiltDeg)}°`
      : "—°";
    const jitter = Number.isFinite(status.stillStd)
      ? ` · jitter ${status.stillStd.toFixed(3)}`
      : "";
    tilt.textContent = `Tilt: ${deg}${jitter}`;
  }
  if (fill?.style) {
    const pct =
      status.state === "ready"
        ? 100
        : status.state === "calibrating"
          ? Math.round((status.progress || 0) * 100)
          : 0;
    fill.style.width = `${pct}%`;
  }
}

function startMotionStreaming() {
  if (sensing || !joined || !clock || !motionAuthorized) return false;
  if (!window.isSecureContext || !window.DeviceMotionEvent) return false;
  if (document.hidden) {
    stopMotion("Keep this page visible and connected, then enable motion again.");
    return false;
  }
  tracker.reset();
  lastCalProgressAt = 0;
  sensing = true;
  notice("");
  $("enable").disabled = true;
  $("enable").textContent = "Motion active";
  $("stop").disabled = false;
  updatePhonePhaseUi({ state: "place_flat", tiltDeg: null, stillStd: Infinity, progress: 0 });
  send({ type: "sensor_status", state: "place_flat" });
  window.addEventListener("devicemotion", motion);
  $("sensorStatus").textContent = "Waiting for motion samples…";
  clearTimeout(noMotionTimer);
  noMotionTimer = setTimeout(() => {
    stopMotion(
      "No sensor samples received. This device may not support motion sensing.",
    );
  }, 5000);
  return true;
}

function tryAutoStartMotion() {
  if (
    role === "phone" &&
    joined &&
    clock &&
    motionAuthorized &&
    wantAutoStart &&
    !sensing
  ) {
    startMotionStreaming();
  }
}

async function handleAcousticSchedule(msg) {
  if (!acousticClient || !micActive) return;
  const sr = acousticClient.sampleRate || 48000;
  const selfFrames = new Map();
  const baseMs = performance.now();

  for (const item of msg.schedule || []) {
    const waitMs = Math.max(0, item.delayMs - (performance.now() - baseMs));
    await new Promise((r) => setTimeout(r, waitMs));
    if (!micActive) return;
    if (item.emitterId === selfDeviceId) {
      const f = acousticClient.playCalibrationChirp({
        f0: 2000,
        f1: 6000,
        durationSec: 0.08,
      });
      selfFrames.set(`${item.round}:${item.emitterId}`, f);
    }
  }
  await new Promise((r) => setTimeout(r, 350));
  if (!micActive) return;

  const arrivals = [];
  for (const item of msg.schedule || []) {
    const key = `${item.round}:${item.emitterId}`;
    const frameGuess =
      item.emitterId === selfDeviceId
        ? selfFrames.get(key)
        : acousticClient.currentFrame() -
          Math.round(((msg.schedule.at(-1).delayMs - item.delayMs + 350) / 1000) * sr);
    if (!Number.isFinite(frameGuess)) continue;
    const found = acousticClient.findLocalChirp(frameGuess, 0.45, 0.55, {
      f0: 2000,
      f1: 6000,
      durationSec: 0.08,
      minSnr: 5.5,
    });
    if (found) {
      arrivals.push({
        round: item.round,
        emitterId: item.emitterId,
        frame: found.frame,
        sampleRate: sr,
        snr: found.snr,
      });
    }
  }
  send({
    type: "acoustic_report",
    calibrationId: msg.calibrationId,
    arrivals,
  });
}

function connect() {
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`,
  );
  ws.onopen = () => {
    $("connection").textContent = "● Connected";
    clockSamples = [];
    clock = null;
    if (role && code) {
      send({
        type: "join",
        role,
        code,
        token: credential,
        name: $("name")?.value?.trim() || undefined,
        sensorState: role === "phone" ? "paused" : undefined,
      });
      send({ type: "mode", mode });
    }
    for (let i = 0; i < 8; i++) send({ type: "ping", sent: Date.now() });
  };
  ws.onclose = () => {
    joined = false;
    $("connection").textContent = "○ Reconnecting";
    stopMotion("Connection lost. Reconnect, then tap Enable motion.");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "pong") {
      clockSamples.push({
        sent: m.sent,
        received: Date.now(),
        server: m.server,
      });
      clockSamples = clockSamples.slice(-30);
      clock = estimateClock(clockSamples);
      if (role === "phone" && joined) {
        send({ type: "sync", ...clock });
        tryAutoStartMotion();
      }
      scheduleRender();
    }
    if (m.type === "error") {
      notice(m.message);
      if (
        m.message.includes("Room not found") ||
        m.message.includes("credential")
      ) {
        role = null;
        code = null;
        credential = null;
        wantAutoStart = false;
        $("landing").hidden = false;
        $("dashboard").hidden = true;
        $("phone").hidden = true;
        if ($("projector")) $("projector").hidden = true;
      }
    }
    if (m.type === "created") {
      role = "host";
      code = m.code;
      credential = m.token;
      joined = true;
      qrKey = "";
      playedEventIds.clear();
      showRoom();
      refreshQrDisplays();
    }
    if (m.type === "joined") {
      credential = m.token;
      code = m.code;
      selfDeviceId = m.deviceId || null;
      joined = true;
      showRoom();
      if (clock) send({ type: "sync", ...clock });
      tryAutoStartMotion();
    }
    if (m.type === "state") {
      for (const device of m.devices) {
        if (!device.points)
          device.points =
            device.bufferCount && device.connected
              ? state?.devices.find((d) => d.id === device.id)?.points || []
              : [];
      }
      for (const ev of m.events || []) recordPlayedId(ev.id);
      state = m;
      joined = true;
      if (!$("landing").hidden) showRoom();
      layoutKey = "";
      projector.setState(state, Date.now() + (clock?.offset || 0));
      refreshQrDisplays();
      scheduleRender();
    }
    if (m.type === "telemetry" && state) {
      for (const delta of m.devices) {
        const d = state.devices.find((d) => d.id === delta.id);
        if (!d) continue;
        const last = d.points.at(-1)?.seq || 0;
        d.points = [
          ...d.points,
          ...delta.points.filter((p) => p.seq > last),
        ].slice(-250);
        d.rate = delta.rate;
        d.lastSeen = delta.lastSeen;
      }
      scheduleRender();
    }
    if (m.type === "event" && state) {
      const event = m.event;
      upsertEvent(event);
      if (canPlayEvent(event)) {
        recordPlayedId(event.id);
        triggerPerformanceOutput(event);
      }
      scheduleRender();
    }
    if (m.type === "events" && state) {
      for (const event of m.events || []) {
        upsertEvent(event);
        if (canPlayEvent(event)) {
          recordPlayedId(event.id);
          triggerPerformanceOutput(event);
        }
      }
      scheduleRender();
    }
    if (m.type === "event_update" && state) {
      const updated = m.event;
      upsertEvent(updated);
      projector.enrichRipple(updated);
      scheduleRender();
    }
    if (m.type === "acoustic_schedule" && role === "phone") {
      handleAcousticSchedule(m);
    }
    if (m.type === "acoustic_result" && role === "host") {
      const el = $("acousticStatus");
      if (el) {
        if (m.status === "measured") {
          el.textContent = `Measured relative (±${Math.round(m.medianResidualCm)} cm)`;
        } else if (m.status === "skipped") {
          el.textContent = m.message || "Skipped";
        } else {
          el.textContent = `Low confidence (±${Math.round(m.medianResidualCm ?? 99)} cm) — kept schematic`;
        }
      }
    }
  };
}

function showRoom() {
  $("landing").hidden = true;
  $("phone").hidden = role !== "phone";
  $("dashboard").hidden = role !== "host";
  if ($("projector")) $("projector").hidden = !(role === "host" && projectorOpen);
  if ($("roomCode")) $("roomCode").textContent = code;
  if ($("projCode")) $("projCode").textContent = code;
  if ($("phoneTitle")) $("phoneTitle").textContent = `Sensor in room ${code}`;
  notice("");
  updateAudioUi();
  updateAssistUi();
}

$("create").onclick = () => {
  ensureAudioUnlocked();
  if (ws.readyState !== 1) {
    notice("Waiting for the server connection.");
    return;
  }
  send({ type: "create" });
};

$("join").onclick = async () => {
  const value = $("code").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(value)) {
    notice("Enter the six-character room code.");
    return;
  }
  if (ws.readyState !== 1) {
    notice("Waiting for the server connection.");
    return;
  }

  let granted = false;
  if (!window.isSecureContext) {
    notice(
      "Motion sensors require HTTPS on phones. Use the trusted local HTTPS setup in README / VALIDATION.md.",
    );
  } else if (!window.DeviceMotionEvent) {
    notice(
      "Motion sensors are unsupported in this browser. Try Safari on iOS or Chrome on Android, or use host simulation.",
    );
  } else {
    try {
      if (typeof DeviceMotionEvent.requestPermission === "function") {
        // Invoke permission synchronously inside user tap gesture before awaiting join
        const permission = await DeviceMotionEvent.requestPermission();
        granted = permission === "granted";
        if (!granted) {
          notice(
            "Motion permission was denied. Enable motion access in browser settings and tap Enable motion to retry.",
          );
        }
      } else {
        granted = true;
      }
    } catch (err) {
      notice(`Could not request motion permission: ${err.message}`);
    }
  }

  motionAuthorized = granted;
  wantAutoStart = granted;
  code = value;
  role = "phone";
  send({
    type: "join",
    code,
    name: $("name")?.value?.trim() || undefined,
    sensorState: "paused",
  });
};

if ($("copy")) {
  $("copy").onclick = async () => {
    const url = joinUrlFor(code);
    try {
      await navigator.clipboard.writeText(url);
      notice(
        `Join link copied. ${location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "For real phones, reopen the host at its HTTPS LAN address and copy again." : ""}`,
      );
    } catch {
      notice(`Phone join link: ${url}`);
    }
  };
}

if ($("mode")) {
  $("mode").onchange = () => {
    mode = $("mode").value;
    projector.setEco(mode === "eco");
    send({ type: "mode", mode });
  };
}

if ($("simulate")) {
  $("simulate").onclick = () =>
    send({ type: "simulation", enabled: !state?.simulation });
}
if ($("impact")) {
  $("impact").onclick = () => send({ type: "impact" });
}

for (const id of ["threshold", "windowMs"]) {
  if ($(id)) {
    $(id).oninput = () => {
      send({
        type: "settings",
        profile: $("profile")?.value || state?.settings?.profile || "lab",
        threshold: +$("threshold").value,
        windowMs: +$("windowMs").value,
      });
    };
  }
}

if ($("profile")) {
  $("profile").onchange = () => {
    const profile = $("profile").value;
    const defaultWindow = profile === "performance" ? 110 : 180;
    send({
      type: "settings",
      profile,
      threshold: +($("threshold")?.value || 5),
      windowMs: defaultWindow,
    });
  };
}

if ($("unlockAudio")) {
  $("unlockAudio").onclick = () => ensureAudioUnlocked();
}
if ($("projAudioBtn")) {
  $("projAudioBtn").onclick = () => ensureAudioUnlocked();
}

if ($("instrumentMode")) {
  $("instrumentMode").onchange = () => {
    instrumentMode = $("instrumentMode").value === "assist" ? "assist" : "free";
    ensureAudioUnlocked();
    updateAssistUi();
  };
}
if ($("freeVoice")) {
  $("freeVoice").onchange = () => {
    freeVoice = $("freeVoice").value;
    updateAssistUi();
  };
}
if ($("auditionSim")) {
  $("auditionSim").onchange = () => {
    auditionSim = Boolean($("auditionSim").checked);
    scheduleRender();
  };
}

if ($("assistBack")) {
  $("assistBack").onclick = () => {
    assist.stepBack();
    updateAssistUi();
  };
}
if ($("assistReset")) {
  $("assistReset").onclick = () => {
    assist.reset();
    updateAssistUi();
  };
}
if ($("projAssistReset")) {
  $("projAssistReset").onclick = () => {
    assist.reset();
    updateAssistUi();
  };
}

if ($("midiFile")) {
  $("midiFile").onchange = async (ev) => {
    const file = ev.target?.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      parsedMidi = parseMidiArrayBuffer(buf);
      const nonEmpty = parsedMidi.tracks.filter((t) => t.notes.length > 0);
      if (!nonEmpty.length) {
        notice("MIDI file has no note tracks.");
        return;
      }
      const sel = $("midiTrack");
      if (sel) {
        sel.innerHTML = nonEmpty
          .map(
            (t) =>
              `<option value="${t.index}">${escape(t.name || `Track ${t.index + 1}`)} (${t.notes.length} notes)</option>`,
          )
          .join("");
        sel.hidden = false;
      }
      if ($("useBuiltinCue")) $("useBuiltinCue").hidden = false;
      const score = groupTrackToAssistSteps(nonEmpty[0], {
        title: file.name.replace(/\.mid(i)?$/i, ""),
      });
      assist.loadScore(score);
      instrumentMode = "assist";
      if ($("instrumentMode")) $("instrumentMode").value = "assist";
      updateAssistUi();
      notice("");
    } catch (err) {
      notice(`Could not load MIDI: ${err.message}`);
    }
  };
}

if ($("midiTrack")) {
  $("midiTrack").onchange = () => {
    if (!parsedMidi) return;
    const idx = Number($("midiTrack").value);
    const track = parsedMidi.tracks.find((t) => t.index === idx);
    if (!track || !track.notes.length) return;
    const score = groupTrackToAssistSteps(track, {
      title: track.name || `Track ${idx + 1}`,
    });
    assist.loadScore(score);
    updateAssistUi();
  };
}

if ($("useBuiltinCue")) {
  $("useBuiltinCue").onclick = () => {
    assist.loadScore(ASHEN_CATHEDRAL_CUE);
    if ($("midiTrack")) $("midiTrack").hidden = true;
    if ($("useBuiltinCue")) $("useBuiltinCue").hidden = true;
    updateAssistUi();
  };
}

if ($("openProjector")) {
  $("openProjector").onclick = () => {
    ensureAudioUnlocked();
    projectorOpen = true;
    if (state?.settings?.profile === "lab") {
      send({
        type: "settings",
        profile: "performance",
        threshold: state.settings.threshold,
        windowMs: 110,
      });
    }
    if ($("projector")) $("projector").hidden = false;
    refreshQrDisplays();
    scheduleRender();
  };
}
if ($("closeProjector")) {
  $("closeProjector").onclick = () => {
    projectorOpen = false;
    if ($("projector")) $("projector").hidden = true;
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  };
}
if ($("projFullscreen")) {
  $("projFullscreen").onclick = () => {
    const el = $("projector");
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };
}
if ($("projQrToggle")) {
  $("projQrToggle").onclick = () => {
    const card = $("projQrCard");
    const nextShow = card ? card.hidden : true;
    qrPinned = nextShow;
    scheduleRender();
  };
}
if ($("projHideQr")) {
  $("projHideQr").onclick = () => {
    qrPinned = false;
    scheduleRender();
  };
}

if ($("rotateLayout")) {
  $("rotateLayout").onclick = () => {
    const cur = state?.layout?.rotationDeg || 0;
    send({ type: "layout_transform", rotationDeg: (cur + 90) % 360 });
  };
}
if ($("mirrorLayout")) {
  $("mirrorLayout").onclick = () => {
    send({ type: "layout_transform", mirrorX: !state?.layout?.mirrorX });
  };
}
if ($("resetLayout")) {
  $("resetLayout").onclick = () => {
    send({ type: "layout_reset" });
  };
}
if ($("runAcoustics")) {
  $("runAcoustics").onclick = () => {
    if ($("acousticStatus")) $("acousticStatus").textContent = "Calibrating chirps…";
    send({ type: "acoustic_calibrate", rounds: 2 });
  };
}

if ($("toggleMic")) {
  $("toggleMic").onclick = async () => {
    if (!micActive) {
      try {
        acousticClient ||= new AcousticExperimentClient({
          liveTransientEnabled: false,
        });
        await acousticClient.startMic();
        micActive = true;
        if ($("toggleMic")) $("toggleMic").textContent = "Disable microphone";
        if ($("micBadge")) $("micBadge").textContent = "ACTIVE";
        if ($("micStatus")) {
          $("micStatus").textContent =
            "● Microphone ready for optional chirp calibration (no audio streamed)";
        }
        send({ type: "acoustic_status", micReady: true });
      } catch (err) {
        micActive = false;
        if ($("micBadge")) $("micBadge").textContent = "DECLINED";
        if ($("micStatus")) {
          $("micStatus").textContent =
            `○ Microphone unavailable (${err.message}) — motion sensing unaffected`;
        }
        send({ type: "acoustic_status", micReady: false });
      }
    } else {
      await acousticClient?.stopMic();
      micActive = false;
      if ($("toggleMic")) $("toggleMic").textContent = "Enable optional microphone";
      if ($("micBadge")) $("micBadge").textContent = "OFF";
      if ($("micStatus")) {
        $("micStatus").textContent = "○ Microphone off · motion-only mode active";
      }
      send({ type: "acoustic_status", micReady: false });
    }
  };
}

function motion(e) {
  if (!sensing || !joined || !clock) return;
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a || ![a.x, a.y, a.z].every(Number.isFinite)) return;
  const now = Date.now();
  lastMotion = now;
  clearTimeout(noMotionTimer);

  const status = tracker.push({ x: a.x, y: a.y, z: a.z, t: now });
  if (status.changed || (status.state === "calibrating" && now - lastCalProgressAt > 180)) {
    lastCalProgressAt = now;
    updatePhonePhaseUi(status);
  }
  if (status.changed) {
    send({
      type: "sensor_status",
      state: status.state,
      tiltDeg: Number.isFinite(status.tiltDeg)
        ? Math.round(status.tiltDeg * 10) / 10
        : null,
      stillStd: Number.isFinite(status.stillStd)
        ? Math.round(status.stillStd * 1000) / 1000
        : null,
    });
  }

  const magnitude = Math.hypot(a.x, a.y, a.z);
  batch.push({ t: now + clock.offset, m: magnitude });
  batch = batch.slice(-100);
  flushSamples();
  const stateTag =
    status.state === "ready"
      ? "Ready"
      : status.state === "calibrating"
        ? "Calibrating"
        : status.state === "moved"
          ? "Moved"
          : "Place flat";
  $("sensorStatus").textContent =
    `● ${stateTag} · ${magnitude.toFixed(2)} m/s² · timing ±${Math.ceil(clock.uncertainty)} ms`;
}

function stopMotion(
  message = "Motion stopped. No samples are being collected.",
) {
  sensing = false;
  wantAutoStart = false;
  window.removeEventListener("devicemotion", motion);
  batch = [];
  clearTimeout(noMotionTimer);
  if ($("enable")) {
    $("enable").disabled = false;
    $("enable").textContent = "Enable motion →";
  }
  if ($("stop")) $("stop").disabled = true;
  if ($("sensorStatus")) $("sensorStatus").textContent = message;
  updatePhonePhaseUi({ state: "paused", tiltDeg: null, stillStd: Infinity, progress: 0 });
  send({ type: "pause" });
}

$("enable").onclick = async () => {
  if (!joined || !clock) {
    notice("Wait for connection and clock calibration, then try again.");
    return;
  }
  if (!window.isSecureContext) {
    notice(
      "Motion sensors require HTTPS on phones. Use the trusted local HTTPS setup in the README.",
    );
    return;
  }
  if (!window.DeviceMotionEvent) {
    notice(
      "Motion sensors are unsupported in this browser. Try Safari on iOS or a supported Android browser, or use host simulation.",
    );
    return;
  }
  try {
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      const permission = await DeviceMotionEvent.requestPermission();
      if (permission !== "granted") {
        motionAuthorized = false;
        notice(
          "Motion permission was denied. You can change browser permission settings and try again.",
        );
        return;
      }
    }
    motionAuthorized = true;
    wantAutoStart = true;
    startMotionStreaming();
  } catch (e) {
    notice(`Could not enable motion: ${e.message}`);
    stopMotion();
  }
};

$("stop").onclick = () => stopMotion();

document.addEventListener("visibilitychange", () => {
  if (document.hidden && sensing)
    stopMotion("Paused when page was hidden. Tap Enable motion to resume.");
});

function flushSamples() {
  if (sensing && batch.length && send({ type: "samples", samples: batch }))
    batch = [];
}

setInterval(flushSamples, 10);
setInterval(() => {
  send({ type: "ping", sent: Date.now() });
  if (sensing && Date.now() - lastMotion > 5000)
    stopMotion("Sensor samples stopped. Tap Enable motion to retry.");
}, 5000);

function computeLabMapCoordinates(devices, layout) {
  const coords = layout?.coords;
  const useMeasured =
    layout?.mode === "measured" &&
    coords &&
    devices.some((d) => Number.isFinite(coords[d.id]?.x) && Number.isFinite(coords[d.id]?.y));

  if (useMeasured) {
    const measured = devices.filter(
      (d) => Number.isFinite(coords[d.id]?.x) && Number.isFinite(coords[d.id]?.y),
    );
    const rotRad = ((Number(layout.rotationDeg) || 0) * Math.PI) / 180;
    const cosR = Math.cos(rotRad),
      sinR = Math.sin(rotRad),
      mirrorX = Boolean(layout.mirrorX);
    const transformed = new Map();
    let maxExtent = 0.25;
    for (const d of measured) {
      let nx = coords[d.id].x,
        ny = coords[d.id].y;
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
    return devices.map((d, i) => {
      const t = transformed.get(d.id);
      if (t) {
        return {
          left: 50 + (t.nx / maxExtent) * 36,
          top: 50 + (t.ny / maxExtent) * 36,
        };
      }
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, devices.length);
      return { left: 50 + 36 * Math.cos(angle), top: 50 + 36 * Math.sin(angle) };
    });
  }

  return devices.map((_, i) => {
    if (devices.length === 1) return { left: 50, top: 50 };
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / devices.length;
    return { left: 50 + 34 * Math.cos(angle), top: 50 + 32 * Math.sin(angle) };
  });
}

function render(frameTime = performance.now()) {
  if (!state) return;
  if (role !== "host") return;

  const p95Text = Number.isFinite(state.processingP95)
    ? `${state.processingP95.toFixed(3)} ms`
    : "Waiting";
  const netText = clock
    ? clock.rtt < 2
      ? "<1 ms"
      : `~${(clock.rtt / 2).toFixed(1)} ms`
    : "Calibrating";

  $("processing").textContent = p95Text;
  $("network").textContent = netText;

  const devices = state.devices,
    active = devices.filter((d) => d.connected),
    real = active.filter((d) => !d.virtual),
    realReady = real.filter((d) => !d.sensorState || d.sensorState === "ready");

  $("count").textContent = String(active.length).padStart(2, "0");
  $("realCount").textContent =
    `${real.length} real (${realReady.length} ready) · ${active.length - real.length} virtual`;
  $("eventCount").textContent = String(state.events.length).padStart(2, "0");

  const qualities = real.filter((d) => d.sync).map((d) => d.sync.uncertainty);
  const syncText = qualities.length
    ? `±${Math.ceil(Math.max(...qualities))} ms`
    : active.length
      ? "Simulated"
      : "—";
  $("syncQuality").textContent = syncText;
  $("arrayHealth").textContent = active.length
    ? "ARRAY CONNECTED"
    : "AWAITING SENSORS";
  $("simulate").textContent = state.simulation
    ? "Stop simulation"
    : "Start simulation";
  $("impact").disabled = !state.simulation;
  $("threshold").value = state.settings.threshold;
  $("windowMs").value = state.settings.windowMs;
  if ($("profile")) $("profile").value = state.settings.profile || "lab";
  $("thresholdValue").textContent = `${state.settings.threshold}× noise`;
  $("windowValue").textContent = `${state.settings.windowMs} ms`;

  const isMeasured = state.layout?.mode === "measured";
  if ($("layoutModeLabel")) {
    $("layoutModeLabel").innerHTML = isMeasured
      ? `MEASURED<br/>±${Math.round(state.layout.residualCm ?? 0)} CM`
      : "SCHEMATIC<br/>LAYOUT";
  }
  if ($("layoutTransformControls")) {
    $("layoutTransformControls").hidden = !isMeasured;
  }

  const now = Date.now() + (clock?.offset || 0),
    last = state.events[0];
  const key = devices
    .map(
      (d) =>
        `${d.id}:${d.name}:${d.connected}:${d.rate}:${d.sensorState}:${d.sync?.uncertainty}:${isMeasured}:${state.layout?.rotationDeg}:${state.layout?.mirrorX}`,
    )
    .join("|");
  if (key !== layoutKey) {
    layoutKey = key;
    $("map").innerHTML = devices.length
      ? devices
          .map(
            (d, i) =>
              `<div id="dot-${i}" class="dot" title="${escape(d.name)}"><span id="dot-label-${i}">S${i + 1}</span></div>`,
          )
          .join("")
      : '<div class="map-empty">Scan QR on phones to join<br><span>or start the virtual array below</span></div>';
    $("devices").innerHTML = devices.length
      ? devices
          .map((d, i) => {
            const st = d.virtual
              ? "VIRTUAL"
              : !d.connected
                ? "DISCONNECTED"
                : d.sensorState === "ready"
                  ? now - d.lastSeen > 3000
                    ? "IDLE"
                    : `${d.rate} Hz · READY`
                  : String(d.sensorState || "PLACE FLAT")
                      .toUpperCase()
                      .replace("_", " ");
            return `<div class="device"><div class="devicehead"><span><span style="color:var(--signal)">●</span> S${i + 1} / ${escape(d.name)}</span><small>${st}</small></div><canvas id="trace-${i}" aria-label="Vibration trace for ${escape(d.name)}"></canvas><div class="device-meta"><span>${d.virtual ? "SYNTHETIC TIMEBASE" : d.sync ? `CLOCK ±${Math.ceil(d.sync.uncertainty)} ms` : "WAITING FOR CLOCK SYNC"}</span><span id="noise-${i}">WAITING FOR MOTION</span></div></div>`;
          })
          .join("")
      : '<div class="empty"><span class="empty-symbol">∿</span><b>A quiet room is a good start.</b><p>Scan QR on phones and lay them flat,<br>or start four virtual sensors below.</p></div>';
  }

  const mapCoords = computeLabMapCoordinates(devices, state.layout);
  devices.forEach((d, i) => {
    const peak = Math.max(
      0,
      ...d.points
        .filter((p) => now - p.time < 350)
        .map((p) => Math.abs(p.value)),
    );
    const onset = last?.participants.find((p) => p.id === d.id);
    const dot = $(`dot-${i}`);
    const pos = mapCoords[i] || { left: 50, top: 50 };
    dot.style.cssText = `left:${pos.left}%;top:${pos.top}%;--glow:${Math.min(35, 7 + peak * 24)}px;opacity:${d.connected ? (d.sensorState === "ready" || d.virtual ? 1 : 0.6) : 0.3}`;
    $(`dot-label-${i}`).textContent =
      onset && now - last.time < 2200
        ? `+${Math.round(onset.time - last.time)} ms`
        : `S${i + 1}`;
    $(`noise-${i}`).textContent = d.points.length
      ? `NOISE ${d.points.at(-1).noise.toFixed(3)} m/s²`
      : "WAITING FOR MOTION";
  });

  devices.forEach((d, i) => {
    const canvas = $(`trace-${i}`),
      ctx = canvas.getContext("2d"),
      width = canvas.clientWidth,
      height = canvas.clientHeight || 50,
      dpr = devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#304539";
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.strokeStyle = d.virtual ? "#c8e995" : "#84d9ce";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let first = true;
    for (const p of d.points) {
      const x = width * (1 - (now - p.time) / 3000);
      if (x < 0) continue;
      const y =
        height / 2 - Math.max(-1.5, Math.min(1.5, p.value)) * (height / 3.4);
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  const nextEvents = state.events
    .map((e) => `${e.id}:${e.participants?.length || 0}`)
    .join("|");
  if (nextEvents !== eventsKey) {
    eventsKey = nextEvents;
    $("events").innerHTML = state.events.length
      ? state.events
          .map(
            (e) =>
              `<div class="event"><span class="event-icon">⌁</span><div><b>${e.origin === "simulated" ? "Simulated impact" : "Shared impact"} · ${e.participants.length} sensors</b><p>${e.peak.toFixed(2)} m/s² peak · ${Math.round(Math.max(...e.participants.map((p) => p.time)) - e.time)} ms onset spread</p><p>${e.participants.map((p) => escape(p.name)).join(" + ")}</p></div><time>${new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>`,
          )
          .join("")
      : '<div class="empty"><b>Listening for a shared moment.</b><p>Two ready sensors must trigger together.</p></div>';
  }

  // Update Projector Stage HUD and draw stage when open
  if ($("projSensors")) {
    $("projSensors").textContent = `${realReady.length} ready / ${active.length} total`;
  }
  if ($("projProfileBadge")) {
    $("projProfileBadge").textContent =
      (state.settings?.profile || "lab").toUpperCase();
  }
  if ($("projHealth")) {
    $("projHealth").textContent = `p95 ${p95Text} · Net ${netText} · Clock ${syncText}`;
  }
  if ($("projSimBadge")) {
    $("projSimBadge").hidden = !state.simulation;
    $("projSimBadge").textContent = auditionSim
      ? "SIMULATION (AUDITIONING AUDIO)"
      : "SIMULATION (LIVE AUDIO MUTED)";
  }
  if ($("projLobbySensors")) {
    $("projLobbySensors").innerHTML = devices.length
      ? devices
          .map((d) => {
            const label = d.virtual
              ? "VIRTUAL"
              : !d.connected
                ? "OFFLINE"
                : (d.sensorState || "ready").toUpperCase().replace("_", " ");
            const cls =
              d.connected && (d.virtual || d.sensorState === "ready")
                ? "proj-sensor-chip ready"
                : "proj-sensor-chip";
            return `<span class="${cls}">${escape(d.name)} · ${label}</span>`;
          })
          .join("")
      : '<span class="proj-sensor-chip">No phones joined yet</span>';
  }
  if ($("projQrCard")) {
    const autoShowLobby = realReady.length < 2 && !state.simulation;
    $("projQrCard").hidden = qrPinned !== null ? !qrPinned : !autoShowLobby;
  }

  projector.setState(state, now);
  if ($("projLayoutBadge")) {
    $("projLayoutBadge").textContent = projector.getLayoutMode();
  }
  if (projectorOpen) {
    projector.draw(frameTime, now);
  }
}

const requested = new URLSearchParams(location.search).get("room");
if (requested) {
  $("code").value = requested.slice(0, 6).toUpperCase();
  document.body?.classList?.add?.("compact-hero");
  const roleHeading = document.querySelector?.(".role-heading");
  if (roleHeading) {
    roleHeading.textContent =
      "JOIN THE ARRAY / Tap Join & Enable Motion, then lay your phone flat.";
  }
  $("code").focus?.();
}

connect();
updateAudioUi();
updateAssistUi();

function animate(time) {
  if (
    state &&
    role === "host" &&
    !document.hidden &&
    time - lastPaint > (mode === "eco" ? 100 : 0)
  )
    scheduleRender();
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
