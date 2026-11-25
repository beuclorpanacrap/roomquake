import test from "node:test";
import assert from "node:assert/strict";
import { encodeQrMatrix, renderQrSvg } from "../lib/qr.js";
import { ProjectorStage } from "../public/projector.js";

function assertFinderPattern(matrix, top, left) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const dist = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      const expected = dist === 2 ? 0 : 1;
      assert.equal(
        matrix[top + r][left + c],
        expected,
        `Finder mismatch at (${top + r}, ${left + c})`,
      );
    }
  }
}

function createMockCanvas(width = 800, height = 500) {
  const ops = [];
  let shadowBlurVal = 0;
  let maxShadowBlur = 0;

  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    globalAlpha: 1,
    get shadowBlur() {
      return shadowBlurVal;
    },
    set shadowBlur(v) {
      shadowBlurVal = v;
      if (v > maxShadowBlur) maxShadowBlur = v;
      ops.push({ type: "shadowBlur", value: v });
    },
    shadowColor: "",
    setTransform() {},
    save() {},
    restore() {},
    setLineDash() {},
    createRadialGradient() {
      return { addColorStop() {} };
    },
    fillRect(x, y, w, h) {
      ops.push({ type: "fillRect", x, y, w, h });
    },
    strokeRect(x, y, w, h) {
      ops.push({ type: "strokeRect", x, y, w, h });
    },
    beginPath() {},
    closePath() {},
    moveTo(x, y) {
      ops.push({ type: "moveTo", x, y });
    },
    lineTo(x, y) {
      ops.push({ type: "lineTo", x, y });
    },
    arc(x, y, r) {
      ops.push({ type: "arc", x, y, r });
    },
    ellipse(x, y, rx, ry) {
      ops.push({ type: "ellipse", x, y, rx, ry });
    },
    rect(x, y, w, h) {
      ops.push({ type: "rect", x, y, w, h });
    },
    roundRect(x, y, w, h) {
      ops.push({ type: "roundRect", x, y, w, h });
    },
    fill() {
      ops.push({ type: "fill" });
    },
    stroke() {
      ops.push({ type: "stroke" });
    },
    fillText(text, x, y) {
      ops.push({ type: "fillText", text: String(text), x, y });
    },
  };

  return {
    clientWidth: width,
    clientHeight: height,
    width,
    height,
    getContext: () => ctx,
    ops,
    get maxShadowBlur() {
      return maxShadowBlur;
    },
    resetTracking() {
      ops.length = 0;
      maxShadowBlur = 0;
      shadowBlurVal = 0;
    },
  };
}

test("encodeQrMatrix encodes short LAN and long tunnel URLs with valid ISO 18004 structure", () => {
  const shortUrl = "https://192.168.1.25:3000/?room=ABC123";
  const tunnelUrl =
    "https://my-roomquake-demo-tunnel.trycloudflare.com/?room=XYZ789";
  const longFallbackUrl =
    "https://very-long-tunnel-subdomain-for-stage-demo.trycloudflare.com/?room=ROOM42&mode=projector&extra=1234567890abcd";

  for (const [label, url, expectedEc] of [
    ["short LAN", shortUrl, "M"],
    ["tunnel", tunnelUrl, "M"],
    ["long EC-L fallback", longFallbackUrl, "L"],
  ]) {
    const matrix = encodeQrMatrix(url);
    const n = matrix.length;
    assert.ok(matrix.version >= 1 && matrix.version <= 6, `${label}: version ${matrix.version}`);
    assert.equal(n, 21 + 4 * (matrix.version - 1), `${label}: square dimension`);
    assert.equal(matrix.ecLevel, expectedEc, `${label}: EC level`);
    for (const row of matrix) {
      assert.equal(row.length, n);
      for (const cell of row) assert.ok(cell === 0 || cell === 1);
    }

    // Verify 7x7 finder corners and dark module.
    assertFinderPattern(matrix, 0, 0);
    assertFinderPattern(matrix, 0, n - 7);
    assertFinderPattern(matrix, n - 7, 0);
    assert.equal(matrix[n - 8][8], 1, `${label}: dark module`);

    // Verify timing patterns on row 6 & col 6.
    for (let i = 8; i < n - 8; i++) {
      assert.equal(matrix[6][i], i % 2 === 0 ? 1 : 0);
      assert.equal(matrix[i][6], i % 2 === 0 ? 1 : 0);
    }
  }
});

test("renderQrSvg produces crisp single-path SVG with configured viewBox and colors", () => {
  const url = "https://my-roomquake-demo-tunnel.trycloudflare.com/?room=XYZ789";
  const matrix = encodeQrMatrix(url);
  const margin = 2;
  const viewSize = matrix.length + margin * 2;
  const svg = renderQrSvg(url, {
    size: 240,
    margin,
    fg: "#141816",
    bg: "#ffffff",
  });

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes(`viewBox="0 0 ${viewSize} ${viewSize}"`));
  assert.ok(svg.includes('width="240" height="240"'));
  assert.ok(svg.includes(`<rect width="${viewSize}" height="${viewSize}" fill="#ffffff"/>`));
  const paths = svg.match(/<path /g) || [];
  assert.equal(paths.length, 1, "SVG should render dark modules in a single <path>");
  assert.ok(svg.includes('fill="#141816"'));
  assert.ok(svg.endsWith("</svg>"));
});

test("ProjectorStage computes schematic symmetry layout and measured relative layout with transforms", () => {
  const stageCanvas = createMockCanvas(800, 500);
  const traceCanvas = createMockCanvas(800, 160);
  const reported = [];
  const stage = new ProjectorStage({
    canvas: stageCanvas,
    traceCanvas,
    onNodePositions: (positions, meta) => reported.push({ positions, meta }),
  });

  // 1. Schematic layout (ignores fake d.x / d.y grid coordinates).
  const baseDevices = [
    { id: "d1", name: "North", x: 0, y: 0, connected: true, sync: { uncertainty: 4 }, points: [] },
    { id: "d2", name: "East", x: 0, y: 0, connected: true, sync: { uncertainty: 5 }, points: [] },
    { id: "d3", name: "South", x: 0, y: 0, connected: true, sync: { uncertainty: 3 }, points: [] },
    { id: "d4", name: "West", x: 0, y: 0, connected: true, sync: { uncertainty: 6 }, points: [] },
  ];
  stage.setState({ devices: baseDevices, events: [], layout: { mode: "schematic" } }, 1000);
  stage.draw(1000, 1000);

  assert.equal(stage.getLayoutMode(), "SCHEMATIC LAYOUT");
  const schem = stage.getNodePositions();
  assert.equal(schem.length, 4);
  // All 4 nodes must occupy distinct symmetrical positions even though d.x=0, d.y=0.
  const distinctCoords = new Set(schem.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
  assert.equal(distinctCoords.size, 4);
  const centerX = schem.reduce((s, p) => s + p.x, 0) / 4;
  const centerY = schem.reduce((s, p) => s + p.y, 0) / 4;
  assert.ok(Math.abs(centerX - 400) < 1);
  assert.ok(stageCanvas.ops.some((op) => op.type === "fillText" && op.text === "SCHEMATIC LAYOUT"));
  assert.ok(reported.at(-1).meta.mode === "SCHEMATIC LAYOUT");

  // 2. Measured layout with rotationDeg and mirrorX.
  const coords = {
    d1: { x: 0.2, y: 0.5 },
    d2: { x: 0.8, y: 0.5 },
    d3: { x: 0.5, y: 0.2 },
    d4: { x: 0.5, y: 0.8 },
  };
  stage.setState(
    {
      devices: baseDevices,
      events: [],
      layout: { mode: "measured", coords, rotationDeg: 0, mirrorX: false },
    },
    1050,
  );
  const unmirrored = stage.getNodePositions();
  assert.equal(stage.getLayoutMode(), "MEASURED RELATIVE LAYOUT");
  assert.ok(unmirrored[0].x < unmirrored[1].x, "d1 at x=0.2 should be left of d2 at x=0.8");
  assert.ok(Math.abs(unmirrored[0].y - centerY) < 2);

  stage.setState(
    {
      devices: baseDevices,
      events: [],
      layout: { mode: "measured", coords, rotationDeg: 90, mirrorX: true },
    },
    1100,
  );
  stageCanvas.resetTracking();
  stage.draw(1100, 1100);
  const transformed = stage.getNodePositions();
  // MirrorX first: d1 (-0.3, 0) -> (+0.3, 0), d2 (+0.3, 0) -> (-0.3, 0), d3 (0, -0.3) -> (0, -0.3).
  // Then +90deg rotation: d1 -> (0, +0.3) [bottom], d2 -> (0, -0.3) [top], d3 -> (+0.3, 0) [right], d4 -> (-0.3, 0) [left].
  assert.ok(transformed[0].y > transformed[1].y, "mirrorX + 90deg puts d1 below d2");
  assert.ok(transformed[2].x > transformed[3].x, "mirrorX + 90deg puts d3 right of d4");
  assert.ok(
    stageCanvas.ops.some((op) => op.type === "fillText" && op.text === "MEASURED RELATIVE LAYOUT"),
  );
});

test("ProjectorStage handles triggerRipple, late enrichRipple without decay reset, isolated bumps, traces, and eco mode", () => {
  const stageCanvas = createMockCanvas(900, 540);
  const traceCanvas = createMockCanvas(900, 180);
  const stage = new ProjectorStage({ canvas: stageCanvas, traceCanvas });

  const now = 10000;
  const devices = [
    {
      id: "s1",
      name: "Phone 1",
      connected: true,
      sync: { uncertainty: 2 },
      points: [
        { time: now - 1500, value: 0.02, trigger: false },
        { time: now - 40, value: 1.2, trigger: true },
      ],
    },
    {
      id: "s2",
      name: "Phone 2",
      connected: true,
      status: "ready",
      sync: { uncertainty: 3 },
      points: [
        { time: now - 1500, value: -0.01, trigger: false },
        { time: now - 25, value: -1.1, trigger: true },
      ],
    },
    {
      id: "s3",
      name: "Phone 3",
      connected: true,
      status: "calibrating",
      points: [{ time: now - 500, value: 0.01, trigger: false }],
    },
    {
      id: "s4",
      name: "Phone 4",
      connected: true,
      status: "place_flat",
      points: [],
    },
    {
      id: "s5",
      name: "Phone 5",
      connected: true,
      status: "moved",
      points: [],
    },
    {
      id: "s6",
      name: "Sim 6",
      connected: true,
      virtual: true,
      points: [],
    },
    {
      id: "s7",
      name: "Offline 7",
      connected: false,
      points: [],
    },
  ];

  stage.setState({ devices, events: [], simulation: false }, now);

  // Primary ripple at t = 10000 with 2 confirming participants.
  stage.triggerRipple(
    {
      id: "evt-1",
      time: now,
      peak: 1.2,
      participants: [
        { id: "s1", name: "Phone 1", time: now, value: 1.2 },
        { id: "s2", name: "Phone 2", time: now + 15, value: -1.1 },
      ],
    },
    2.4,
  );

  // Late confirmation from 3rd and 4th sensors enriches evt-1 without duplicating or resetting decay.
  const enriched = stage.enrichRipple({
    id: "evt-1",
    peak: 1.4,
    participants: [
      { id: "s1", name: "Phone 1", time: now, value: 1.2 },
      { id: "s2", name: "Phone 2", time: now + 15, value: -1.1 },
      { id: "s3", name: "Phone 3", time: now + 70, value: 1.4 },
      { id: "s4", name: "Phone 4", time: now + 95, value: 0.95 },
    ],
  });
  assert.equal(enriched, true);
  assert.equal(stage.getActiveRipples().length, 1);
  const evt1 = stage.getActiveRipples().find((r) => r.id === "evt-1");
  assert.equal(evt1.participants.length, 4);
  assert.equal(evt1.peak, 1.4);

  // Draw in high-performance mode -> shadowBlur used, traces rendered, state tags & onset badges rendered.
  stageCanvas.resetTracking();
  traceCanvas.resetTracking();
  stage.draw(10150, now + 150);
  assert.ok(stageCanvas.maxShadowBlur > 0, "performance mode should use shadowBlur");
  assert.ok(stageCanvas.ops.some((op) => op.type === "fillText" && op.text === "+15 ms"));
  assert.ok(stageCanvas.ops.some((op) => op.type === "fillText" && op.text === "+70 ms"));
  assert.ok(stageCanvas.ops.some((op) => op.type === "fillText" && op.text === "+95 ms"));
  for (const tag of ["READY", "CALIBRATING", "PLACE FLAT", "MOVED", "VIRTUAL", "OFFLINE"]) {
    assert.ok(
      stageCanvas.ops.some((op) => op.type === "fillText" && op.text.includes(tag)),
      `missing node state label ${tag}`,
    );
  }
  assert.ok(traceCanvas.ops.some((op) => op.type === "lineTo"));
  assert.ok(
    traceCanvas.ops.some(
      (op) => op.type === "fillText" && op.text.includes("SCALE ±1.5 m/s²"),
    ),
  );

  // Overlapping second tap 400ms later.
  stage.triggerRipple(
    {
      id: "evt-2",
      time: now + 400,
      peak: 0.9,
      participants: [
        { id: "s1", name: "Phone 1", time: now + 400, value: 0.9 },
        { id: "s2", name: "Phone 2", time: now + 412, value: -0.8 },
      ],
    },
    2.4,
  );
  assert.equal(stage.getActiveRipples().length, 2);

  // Measure performance-mode arc density with both overlapping ripples active, then compare Eco mode.
  stageCanvas.resetTracking();
  stage.draw(10450, now + 450);
  const perfArcCount = stageCanvas.ops.filter((op) => op.type === "arc").length;
  assert.ok(stageCanvas.ops.some((op) => op.type === "fillText" && op.text === "+12 ms"));

  stage.setEco(true);
  stageCanvas.resetTracking();
  stage.draw(10450, now + 450);
  const ecoArcCount = stageCanvas.ops.filter((op) => op.type === "arc").length;
  assert.equal(stageCanvas.maxShadowBlur, 0, "eco mode must disable shadowBlur");
  assert.ok(ecoArcCount < perfArcCount, "eco mode should lower ring density");
  assert.ok(
    stageCanvas.ops.some((op) => op.type === "fillText" && op.text.includes("ECO MODE")),
  );

  // Decay check: evt-1 started at now (10000) with decaySec=2.4; even though enriched, it expires at >=12400.
  stage.draw(12450, now + 2450);
  assert.equal(
    stage.getActiveRipples().some((r) => r.id === "evt-1"),
    false,
    "evt-1 must decay from original start time without reset",
  );
  assert.equal(
    stage.getActiveRipples().some((r) => r.id === "evt-2"),
    true,
    "evt-2 (started at +400ms) should still be active at +2450ms",
  );

  // Isolated single-phone bump detection after shared ripples finish.
  stage.draw(13000, now + 3000);
  assert.equal(stage.getActiveRipples().length, 0);
  devices[2].points.push({ time: now + 2920, value: 0.62, trigger: false });
  stage.setState({ devices, events: [] }, now + 3000);
  const bumps = stage.getIsolatedBumpIds(now + 3000);
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].id, "s3");

  stageCanvas.resetTracking();
  stage.draw(13000, now + 3000);
  assert.ok(
    stageCanvas.ops.some((op) => op.type === "fillText" && op.text === "LOCAL BUMP"),
    "isolated bump should render subtle local twitch indicator",
  );
});

test("ProjectorStage instantiates and draws safely without canvases", () => {
  const stage = new ProjectorStage();
  stage.setEco(true);
  stage.setState({ devices: [], events: [] }, 500);
  stage.triggerRipple({ id: "safe-1", time: 500, peak: 1.0, participants: [] });
  assert.equal(stage.enrichRipple({ id: "missing", participants: [] }), false);
  assert.doesNotThrow(() => stage.draw(500, 500));
});
