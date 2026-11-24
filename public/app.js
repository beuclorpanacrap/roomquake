import { estimateClock } from "/lib/signal.js";
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
  state = null,
  sensing = false,
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
  mode = "performance",
  lastPaint = 0;
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
  requestAnimationFrame(() => {
    framePending = false;
    render();
    lastPaint = performance.now();
  });
};
const notice = (s) => ($("notice").textContent = s);
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
        name: $("name").value,
        position: { x: 2, y: 2 },
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
      if (role === "phone" && joined) send({ type: "sync", ...clock });
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
        $("landing").hidden = false;
        $("dashboard").hidden = true;
        $("phone").hidden = true;
      }
    }
    if (m.type === "created") {
      role = "host";
      code = m.code;
      credential = m.token;
      joined = true;
      showRoom();
    }
    if (m.type === "joined") {
      credential = m.token;
      code = m.code;
      joined = true;
      showRoom();
      if (clock) send({ type: "sync", ...clock });
    }
    if (m.type === "state") {
      for (const device of m.devices) {
        if (!device.points)
          device.points =
            device.bufferCount && device.connected
              ? state?.devices.find((d) => d.id === device.id)?.points || []
              : [];
      }
      state = m;
      joined = true;
      if (!$("landing").hidden) showRoom();
      layoutKey = "";
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
    if ((m.type === "event" || m.type === "events") && state) {
      for (const event of m.events || [m.event]) {
        if (!state.events.some((e) => e.id === event.id))
          state.events.unshift(event);
      }
      state.events.sort((a, b) => b.time - a.time);
      state.events = state.events.slice(0, 40);
      scheduleRender();
    }
  };
}
function showRoom() {
  $("landing").hidden = true;
  $("phone").hidden = role !== "phone";
  $("dashboard").hidden = role !== "host";
  $("roomCode").textContent = code;
  $("phoneTitle").textContent = `Sensor in room ${code}`;
  notice("");
}
$("create").onclick = () => {
  if (ws.readyState !== 1) {
    notice("Waiting for the server connection.");
    return;
  }
  send({ type: "create" });
};
$("join").onclick = () => {
  const value = $("code").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(value)) {
    notice("Enter the six-character room code.");
    return;
  }
  if (ws.readyState !== 1) {
    notice("Waiting for the server connection.");
    return;
  }
  code = value;
  role = "phone";
  send({ type: "join", code, name: $("name").value, position: { x: 2, y: 2 } });
};
$("copy").onclick = async () => {
  const url = new URL(location.href);
  url.search = `?room=${code}`;
  try {
    await navigator.clipboard.writeText(url.href);
    notice(
      `Join link copied. ${location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "For real phones, reopen the host at its HTTPS LAN address and copy again." : ""}`,
    );
  } catch {
    notice(`Phone join link: ${url.href}`);
  }
};
$("mode").onchange = () => {
  mode = $("mode").value;
  send({ type: "mode", mode });
};
$("simulate").onclick = () =>
  send({ type: "simulation", enabled: !state?.simulation });
$("impact").onclick = () => send({ type: "impact" });
for (const id of ["threshold", "windowMs"])
  $(id).oninput = () => {
    send({
      type: "settings",
      threshold: +$("threshold").value,
      windowMs: +$("windowMs").value,
    });
  };
for (const id of ["posX", "posY"])
  $(id).onchange = () =>
    send({
      type: "position",
      x: +$("posX").value - 1,
      y: +$("posY").value - 1,
    });
function motion(e) {
  if (!sensing || !joined || !clock) return;
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a || ![a.x, a.y, a.z].every(Number.isFinite)) return;
  const now = Date.now();
  lastMotion = now;
  clearTimeout(noMotionTimer);
  const magnitude = Math.hypot(a.x, a.y, a.z);
  batch.push({ t: now + clock.offset, m: magnitude });
  batch = batch.slice(-100);
  flushSamples();
  $("sensorStatus").textContent =
    `● Sensing · ${magnitude.toFixed(2)} m/s² · timing ±${Math.ceil(clock.uncertainty)} ms`;
}
function stopMotion(
  message = "Motion stopped. No samples are being collected.",
) {
  sensing = false;
  window.removeEventListener("devicemotion", motion);
  batch = [];
  clearTimeout(noMotionTimer);
  $("enable").disabled = false;
  $("stop").disabled = true;
  $("sensorStatus").textContent = message;
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
        notice(
          "Motion permission was denied. You can change browser permission settings and try again.",
        );
        return;
      }
    }
    if (document.hidden || !joined) {
      stopMotion(
        "Keep this page visible and connected, then enable motion again.",
      );
      return;
    }
    sensing = true;
    notice("");
    $("enable").disabled = true;
    $("stop").disabled = false;
    window.addEventListener("devicemotion", motion);
    $("sensorStatus").textContent = "Waiting for motion samples…";
    noMotionTimer = setTimeout(() => {
      stopMotion(
        "No sensor samples received. This device may not support motion sensing.",
      );
    }, 5000);
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
setInterval(flushSamples, 10); // Only retries congested writes; normal samples send immediately.
setInterval(() => {
  send({ type: "ping", sent: Date.now() });
  if (sensing && Date.now() - lastMotion > 5000)
    stopMotion("Sensor samples stopped. Tap Enable motion to retry.");
}, 5000);
function render() {
  if (!state) return;
  if (role !== "host") return;
  $("processing").textContent = Number.isFinite(state.processingP95)
    ? `${state.processingP95.toFixed(3)} ms`
    : "Waiting";
  $("network").textContent = clock
    ? clock.rtt < 2
      ? "<1 ms"
      : `~${(clock.rtt / 2).toFixed(1)} ms`
    : "Calibrating";
  const devices = state.devices,
    active = devices.filter((d) => d.connected),
    real = active.filter((d) => !d.virtual);
  $("count").textContent = String(active.length).padStart(2, "0");
  $("realCount").textContent =
    `${real.length} real · ${active.length - real.length} virtual`;
  $("eventCount").textContent = String(state.events.length).padStart(2, "0");
  const qualities = real.filter((d) => d.sync).map((d) => d.sync.uncertainty);
  $("syncQuality").textContent = qualities.length
    ? `±${Math.ceil(Math.max(...qualities))} ms`
    : active.length
      ? "Simulated"
      : "—";
  $("arrayHealth").textContent = active.length
    ? "ARRAY CONNECTED"
    : "AWAITING SENSORS";
  $("simulate").textContent = state.simulation
    ? "Stop simulation"
    : "Start simulation";
  $("impact").disabled = !state.simulation;
  $("threshold").value = state.settings.threshold;
  $("windowMs").value = state.settings.windowMs;
  $("thresholdValue").textContent = `${state.settings.threshold}× noise`;
  $("windowValue").textContent = `${state.settings.windowMs} ms`;
  const now = Date.now() + (clock?.offset || 0),
    last = state.events[0];
  const key = devices
    .map(
      (d) =>
        `${d.id}:${d.name}:${d.connected}:${d.rate}:${d.sync?.uncertainty}`,
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
      : '<div class="map-empty">Place your first sensor<br><span>or start the virtual array below</span></div>';
    $("devices").innerHTML = devices.length
      ? devices
          .map(
            (d, i) =>
              `<div class="device"><div class="devicehead"><span><span style="color:var(--signal)">●</span> S${i + 1} / ${escape(d.name)}</span><small>${d.virtual ? "VIRTUAL" : !d.connected ? "DISCONNECTED" : now - d.lastSeen > 3000 ? "IDLE" : `${d.rate} Hz`}</small></div><canvas id="trace-${i}" aria-label="Vibration trace for ${escape(d.name)}"></canvas><div class="device-meta"><span>${d.virtual ? "SYNTHETIC TIMEBASE" : d.sync ? `CLOCK ±${Math.ceil(d.sync.uncertainty)} ms` : "WAITING FOR CLOCK SYNC"}</span><span id="noise-${i}">WAITING FOR MOTION</span></div></div>`,
          )
          .join("")
      : '<div class="empty"><span class="empty-symbol">∿</span><b>A quiet room is a good start.</b><p>Join a phone and enable motion,<br>or start four virtual sensors below.</p></div>';
  }
  devices.forEach((d, i) => {
    const peak = Math.max(
      0,
      ...d.points
        .filter((p) => now - p.time < 350)
        .map((p) => Math.abs(p.value)),
    );
    const onset = last?.participants.find((p) => p.id === d.id);
    const dot = $(`dot-${i}`);
    dot.style.cssText = `left:${10 + d.x * 20}%;top:${10 + d.y * 20}%;--glow:${Math.min(35, 7 + peak * 24)}px;opacity:${d.connected ? 1 : 0.3}`;
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
  const nextEvents = state.events.map((e) => e.id).join("|");
  if (nextEvents !== eventsKey) {
    eventsKey = nextEvents;
    $("events").innerHTML = state.events.length
      ? state.events
          .map(
            (e) =>
              `<div class="event"><span class="event-icon">⌁</span><div><b>Shared impact · ${e.participants.length} sensors</b><p>${e.peak.toFixed(2)} m/s² peak · ${Math.round(Math.max(...e.participants.map((p) => p.time)) - e.time)} ms onset spread</p><p>${e.participants.map((p) => escape(p.name)).join(" + ")}</p></div><time>${new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>`,
          )
          .join("")
      : '<div class="empty"><b>Listening for a shared moment.</b><p>Two sensors must trigger together.</p></div>';
  }
}
const requested = new URLSearchParams(location.search).get("room");
if (requested) {
  $("code").value = requested.slice(0, 6).toUpperCase();
  document.body.classList.add("compact-hero");
  document.querySelector(".role-heading").textContent =
    "JOIN THE ARRAY / Your host has shared a room with you.";
  $("code").focus();
}
connect();
// Keep time axes moving without rebuilding DOM at sample cadence.
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
