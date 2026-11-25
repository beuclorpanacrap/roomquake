/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder and SVG renderer.
 * Supports UTF-8 Byte mode across Versions 1–8 (Levels M and L) for offline room onboarding.
 */

const TEXT_ENCODER = new TextEncoder();

// GF(256) lookup tables with primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1).
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

// Format EC level indicator bits per ISO/IEC 18004 Table 12.
const EC_BITS = { M: 0b00, L: 0b01 };

// Alignment pattern center coordinates per version (ISO/IEC 18004 Table E.1).
const ALIGN_COORDS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
};

/**
 * Candidate configurations ordered to prefer EC level M across Versions 1–6,
 * falling back to EC level L for longer URLs (107–134 bytes in V6-L, up to 192 in V8-L).
 * Byte mode uses 4 mode bits + 8 count bits (V1–9), leaving dataCodewords - 2 usable bytes.
 */
const CONFIGS = [
  { version: 1, ecLevel: "M", totalCodewords: 26, dataCodewords: 16, ecPerBlock: 10, groups: [[1, 16]], maxBytes: 14 },
  { version: 2, ecLevel: "M", totalCodewords: 44, dataCodewords: 28, ecPerBlock: 16, groups: [[1, 28]], maxBytes: 26 },
  { version: 3, ecLevel: "M", totalCodewords: 70, dataCodewords: 44, ecPerBlock: 26, groups: [[1, 44]], maxBytes: 42 },
  { version: 4, ecLevel: "M", totalCodewords: 100, dataCodewords: 64, ecPerBlock: 18, groups: [[2, 32]], maxBytes: 62 },
  { version: 5, ecLevel: "M", totalCodewords: 134, dataCodewords: 86, ecPerBlock: 24, groups: [[2, 43]], maxBytes: 84 },
  { version: 6, ecLevel: "M", totalCodewords: 172, dataCodewords: 108, ecPerBlock: 16, groups: [[4, 27]], maxBytes: 106 },
  { version: 6, ecLevel: "L", totalCodewords: 172, dataCodewords: 136, ecPerBlock: 18, groups: [[2, 68]], maxBytes: 134 },
  { version: 7, ecLevel: "L", totalCodewords: 196, dataCodewords: 156, ecPerBlock: 20, groups: [[2, 78]], maxBytes: 154 },
  { version: 8, ecLevel: "L", totalCodewords: 242, dataCodewords: 194, ecPerBlock: 24, groups: [[2, 97]], maxBytes: 192 },
];

const MASK_PREDICATES = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsEncodeBlock(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const buf = new Uint8Array(data.length + ecCount);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 1; j < gen.length; j++) {
      buf[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return buf.slice(data.length);
}

function buildDataCodewords(bytes, cfg) {
  const totalBits = cfg.dataCodewords * 8;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  // Byte mode indicator (0100) + 8-bit byte length (valid for versions 1..9).
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  // Up to 4 terminator zero bits, then pad to byte boundary.
  const term = Math.min(4, totalBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(cfg.dataCodewords);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let b = 0; b < 8; b++) val = (val << 1) | bits[i + b];
    codewords[byteIdx++] = val;
  }

  // Pad remaining capacity with alternating 0xEC / 0x11 codewords.
  let padToggle = 0;
  while (byteIdx < cfg.dataCodewords) {
    codewords[byteIdx++] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }
  return codewords;
}

function buildFinalBitstream(dataCodewords, cfg) {
  const blocks = [];
  let offset = 0;
  for (const [count, len] of cfg.groups) {
    for (let i = 0; i < count; i++) {
      const slice = dataCodewords.slice(offset, offset + len);
      offset += len;
      blocks.push({
        data: slice,
        ec: rsEncodeBlock(slice, cfg.ecPerBlock),
      });
    }
  }

  const interleaved = [];
  const maxDataLen = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const b of blocks) {
      if (i < b.data.length) interleaved.push(b.data[i]);
    }
  }
  for (let i = 0; i < cfg.ecPerBlock; i++) {
    for (const b of blocks) interleaved.push(b.ec[i]);
  }

  const bits = [];
  for (const cw of interleaved) {
    for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  }
  return bits;
}

function computeFormatBits(ecLevel, maskId) {
  const data = (EC_BITS[ecLevel] << 3) | maskId;
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((rem >> (i + 10)) & 1) rem ^= 0x537 << i;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version) {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((rem >> (i + 12)) & 1) rem ^= 0x1f25 << i;
  }
  return (version << 12) | rem;
}

function createFunctionGrid(version) {
  const n = 21 + 4 * (version - 1);
  const grid = Array.from({ length: n }, () => new Array(n).fill(0));
  const isFunc = Array.from({ length: n }, () => new Array(n).fill(false));

  const setFunc = (r, c, val) => {
    if (r >= 0 && r < n && c >= 0 && c < n) {
      grid[r][c] = val;
      isFunc[r][c] = true;
    }
  };

  // Three 7x7 finder patterns + 1-module white separators.
  const placeFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        if (dr === -1 || dr === 7 || dc === -1 || dc === 7) {
          setFunc(r, c, 0);
        } else {
          const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          setFunc(r, c, dist === 2 ? 0 : 1);
        }
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, n - 7);
  placeFinder(n - 7, 0);

  // Timing patterns along row 6 and column 6.
  for (let i = 8; i < n - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    setFunc(6, i, bit);
    setFunc(i, 6, bit);
  }

  // Alignment patterns (skipping centers inside the three finder corners).
  const coords = ALIGN_COORDS[version];
  for (const ar of coords) {
    for (const ac of coords) {
      const inFinder =
        (ar <= 8 && ac <= 8) ||
        (ar <= 8 && ac >= n - 9) ||
        (ar >= n - 9 && ac <= 8);
      if (inFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(ar + dr, ac + dc, dist === 1 ? 0 : 1);
        }
      }
    }
  }

  // Dark module at (4*version + 9, 8).
  setFunc(n - 8, 8, 1);

  // Reserve format info cells (values applied per candidate mask).
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      isFunc[8][i] = true;
      isFunc[i][8] = true;
    }
  }
  for (let i = 0; i < 8; i++) isFunc[8][n - 8 + i] = true;
  for (let i = 0; i < 7; i++) isFunc[n - 7 + i][8] = true;

  // Version info blocks for V7+.
  if (version >= 7) {
    const vBits = computeVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >> i) & 1;
      const rOffset = n - 11 + (i % 3);
      const major = Math.floor(i / 3);
      setFunc(rOffset, major, bit);
      setFunc(major, rOffset, bit);
    }
  }

  return { n, grid, isFunc };
}

function placeDataBits(grid, isFunc, n, bits) {
  let bitIdx = 0;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step++) {
      const row = upward ? n - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const col = right - dx;
        if (!isFunc[row][col]) {
          grid[row][col] = bitIdx < bits.length ? bits[bitIdx++] : 0;
        }
      }
    }
    upward = !upward;
  }
}

function applyFormatInfo(grid, n, ecLevel, maskId) {
  const fmt = computeFormatBits(ecLevel, maskId);
  const topLeftPositions = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
    [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> (14 - i)) & 1;
    const [r1, c1] = topLeftPositions[i];
    grid[r1][c1] = bit;
    if (i < 7) {
      grid[n - 1 - i][8] = bit;
    } else {
      grid[8][n - 15 + i] = bit;
    }
  }
}

function scorePenalty(grid, n) {
  let penalty = 0;

  // Rule 1 & Rule 3 along rows and columns.
  for (let r = 0; r < n; r++) {
    let rowRun = 1;
    let colRun = 1;
    for (let c = 1; c < n; c++) {
      if (grid[r][c] === grid[r][c - 1]) {
        rowRun++;
      } else {
        if (rowRun >= 5) penalty += 3 + (rowRun - 5);
        rowRun = 1;
      }
      if (grid[c][r] === grid[c - 1][r]) {
        colRun++;
      } else {
        if (colRun >= 5) penalty += 3 + (colRun - 5);
        colRun = 1;
      }
    }
    if (rowRun >= 5) penalty += 3 + (rowRun - 5);
    if (colRun >= 5) penalty += 3 + (colRun - 5);

    for (let i = 0; i <= n - 11; i++) {
      if (
        (grid[r][i] === 1 && grid[r][i + 1] === 0 && grid[r][i + 2] === 1 &&
          grid[r][i + 3] === 1 && grid[r][i + 4] === 1 && grid[r][i + 5] === 0 &&
          grid[r][i + 6] === 1 && grid[r][i + 7] === 0 && grid[r][i + 8] === 0 &&
          grid[r][i + 9] === 0 && grid[r][i + 10] === 0) ||
        (grid[r][i] === 0 && grid[r][i + 1] === 0 && grid[r][i + 2] === 0 &&
          grid[r][i + 3] === 0 && grid[r][i + 4] === 1 && grid[r][i + 5] === 0 &&
          grid[r][i + 6] === 1 && grid[r][i + 7] === 1 && grid[r][i + 8] === 1 &&
          grid[r][i + 9] === 0 && grid[r][i + 10] === 1)
      ) {
        penalty += 40;
      }
      if (
        (grid[i][r] === 1 && grid[i + 1][r] === 0 && grid[i + 2][r] === 1 &&
          grid[i + 3][r] === 1 && grid[i + 4][r] === 1 && grid[i + 5][r] === 0 &&
          grid[i + 6][r] === 1 && grid[i + 7][r] === 0 && grid[i + 8][r] === 0 &&
          grid[i + 9][r] === 0 && grid[i + 10][r] === 0) ||
        (grid[i][r] === 0 && grid[i + 1][r] === 0 && grid[i + 2][r] === 0 &&
          grid[i + 3][r] === 0 && grid[i + 4][r] === 1 && grid[i + 5][r] === 0 &&
          grid[i + 6][r] === 1 && grid[i + 7][r] === 1 && grid[i + 8][r] === 1 &&
          grid[i + 9][r] === 0 && grid[i + 10][r] === 1)
      ) {
        penalty += 40;
      }
    }
  }

  // Rule 2: 2x2 same-color blocks.
  let darkCount = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = grid[r][c];
      darkCount += v;
      if (
        r < n - 1 &&
        c < n - 1 &&
        v === grid[r][c + 1] &&
        v === grid[r + 1][c] &&
        v === grid[r + 1][c + 1]
      ) {
        penalty += 3;
      }
    }
  }

  // Rule 4: deviation from 50% dark module density in 5% increments.
  const percent = (darkCount * 100) / (n * n);
  const prev5 = Math.floor(percent / 5) * 5;
  const next5 = prev5 + 5;
  penalty += Math.min(Math.abs(prev5 - 50), Math.abs(next5 - 50)) * 2;
  return penalty;
}

/**
 * Encodes a UTF-8 string into an ISO/IEC 18004 QR matrix of 0/1 module values.
 * @param {string} text
 * @returns {number[][]} Square matrix (`matrix[row][col]` is 1 for dark, 0 for light)
 *   with non-enumerable `version`, `size`, `ecLevel`, and `mask` metadata properties.
 */
export function encodeQrMatrix(text) {
  const bytes = TEXT_ENCODER.encode(String(text ?? ""));
  const cfg = CONFIGS.find((entry) => bytes.length <= entry.maxBytes);
  if (!cfg) {
    throw new RangeError(
      `QR payload too long (${bytes.length} UTF-8 bytes; max supported is ${CONFIGS.at(-1).maxBytes}).`,
    );
  }

  const dataCodewords = buildDataCodewords(bytes, cfg);
  const bits = buildFinalBitstream(dataCodewords, cfg);
  const { n, grid: baseGrid, isFunc } = createFunctionGrid(cfg.version);
  placeDataBits(baseGrid, isFunc, n, bits);

  let bestGrid = null;
  let bestScore = Infinity;
  let bestMask = 0;

  for (let maskId = 0; maskId < 8; maskId++) {
    const fn = MASK_PREDICATES[maskId];
    const candidate = baseGrid.map((row, r) =>
      row.map((val, c) => (isFunc[r][c] ? val : fn(r, c) ? val ^ 1 : val)),
    );
    applyFormatInfo(candidate, n, cfg.ecLevel, maskId);
    const score = scorePenalty(candidate, n);
    if (score < bestScore) {
      bestScore = score;
      bestGrid = candidate;
      bestMask = maskId;
    }
  }

  Object.defineProperties(bestGrid, {
    version: { value: cfg.version },
    size: { value: n },
    ecLevel: { value: cfg.ecLevel },
    mask: { value: bestMask },
  });
  return bestGrid;
}

const escapeXmlAttr = (value) =>
  String(value).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );

/**
 * Renders a crisp offline SVG QR code with a background `<rect>` and single `<path>`.
 * @param {string} text
 * @param {{ size?: number, margin?: number, fg?: string, bg?: string }} [options]
 * @returns {string}
 */
export function renderQrSvg(text, options = {}) {
  const { size = 240, margin = 2, fg = "#141816", bg = "#ffffff" } =
    options || {};
  const matrix = encodeQrMatrix(text);
  const n = matrix.length;
  const pad = Math.max(0, Math.floor(Number(margin) || 0));
  const viewSize = n + pad * 2;
  const pxSize = Math.max(16, Number(size) || 240);

  // Merge horizontally contiguous dark modules per row into single path subpaths
  // to keep SVG compact and prevent hairline seams between adjacent cells.
  const commands = [];
  for (let r = 0; r < n; r++) {
    const row = matrix[r];
    let c = 0;
    while (c < n) {
      if (row[c] === 1) {
        const start = c;
        while (c < n && row[c] === 1) c++;
        const run = c - start;
        commands.push(`M${start + pad},${r + pad}h${run}v1h-${run}z`);
      } else {
        c++;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" ` +
    `width="${pxSize}" height="${pxSize}" role="img" aria-label="Room join QR code" ` +
    `shape-rendering="crispEdges">` +
    `<rect width="${viewSize}" height="${viewSize}" fill="${escapeXmlAttr(bg)}"/>` +
    `<path fill="${escapeXmlAttr(fg)}" d="${commands.join("")}"/>` +
    `</svg>`
  );
}
