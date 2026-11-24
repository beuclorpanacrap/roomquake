// A slow peer retains no application message queue: state and telemetry are
// rebuilt from bounded session buffers on the next writable opportunity.
export const MAX_BUFFERED_BYTES = 64 * 1024;
export function sendBounded(ws, data) {
  if (ws.readyState !== 1 || ws.bufferedAmount > MAX_BUFFERED_BYTES)
    return false;
  ws.send(JSON.stringify(data));
  return true;
}
export function telemetry(room, cursors = new Map()) {
  const devices = [];
  for (const d of room.devices.values()) {
    const after = cursors.get(d.id) || 0;
    const points = d.points.filter((p) => p.seq > after);
    if (points.length)
      devices.push({
        id: d.id,
        points,
        rate: d.rate,
        lastSeen: d.lastSeen,
        samples: d.samples,
      });
  }
  return { type: "telemetry", devices };
}
export function advanceCursors(cursors, message) {
  for (const d of message.devices)
    if (d.points.length) cursors.set(d.id, d.points.at(-1).seq);
}
