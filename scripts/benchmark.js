import { Session } from "../lib/session.js";
import { sendBounded } from "../lib/transport.js";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
export function benchmark({ rounds = 2000, warmup = 300 } = {}) {
  let events = 0,
    bytes = 0;
  const peers = Array.from({ length: 4 }, () => ({
    readyState: 1,
    bufferedAmount: 0,
    send: (json) => {
      bytes += Buffer.byteLength(json);
    },
  }));
  const room = new Session("BENCH", (event) => {
    events++;
    for (const peer of peers) sendBounded(peer, { type: "event", event });
  });
  const devices = Array.from({ length: 24 }, (_, i) =>
    room.join(`Sensor ${i}`, { x: i % 5, y: Math.floor(i / 5) }, `sensor-${i}`),
  );
  const measured = [];
  let time = Date.now();
  for (let round = 0; round < rounds + warmup; round++) {
    time += 50;
    // 24 devices × 5 samples, 100 Hz/device in 50 ms acquisition batches.
    // Every second has a common impulse; all timestamps and samples deterministic.
    const batches = devices.map((_, i) =>
      Array.from({ length: 5 }, (_, j) => ({
        t: time + j * 10,
        m:
          9.81 +
          (((round * 17 + i * 11 + j * 3) % 19) - 9) * 0.001 +
          (round % 20 === 0 && j === 2 ? 1.2 : 0),
      })),
    );
    const start = performance.now();
    for (let i = 0; i < devices.length; i++)
      room.ingest(devices[i].id, batches[i], time + 40);
    const elapsed = performance.now() - start;
    if (round >= warmup) measured.push(elapsed);
  }
  measured.sort((a, b) => a - b);
  return {
    workload:
      "24 sensors × 5 samples per round; 4 event subscribers; seeded impulses every 20 rounds",
    rounds,
    warmup,
    samples: rounds * 120,
    p50Ms: measured[Math.floor(rounds * 0.5)],
    p95Ms: measured[Math.floor(rounds * 0.95)],
    p99Ms: measured[Math.floor(rounds * 0.99)],
    maxMs: measured.at(-1),
    eventDispatches: events,
    serializedBytes: bytes,
    budgetMs: 10,
    scope:
      "In-process ingest/filter/coincidence plus immediate event serialization and synchronous send enqueue; excludes sockets, network, sensor acquisition and paint",
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = benchmark();
  console.log(JSON.stringify(result, null, 2));
  if (result.p95Ms > result.budgetMs) process.exitCode = 1;
}
