import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createApp } from "../server.js";

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return app.server.address().port;
}

test("HTTP responses include public-host security headers and reject writes", async () => {
  const app = createApp();
  const port = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.match(res.headers.get("permissions-policy"), /microphone=\(self\)/);

    const post = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  } finally {
    await app.close();
  }
});

test("production WebSockets accept same-origin and reject foreign or absent origins", async () => {
  const app = createApp({ enforceOrigin: true });
  const port = await listen(app);
  const endpoint = `ws://127.0.0.1:${port}`;
  const connect = (origin) =>
    new Promise((resolve) => {
      const options = origin ? { origin } : {};
      const ws = new WebSocket(endpoint, options);
      ws.once("open", () => resolve({ opened: true, ws }));
      ws.once("unexpected-response", (_req, res) =>
        resolve({ opened: false, status: res.statusCode }),
      );
      ws.once("error", () => resolve({ opened: false, status: 0 }));
    });
  try {
    const same = await connect(`http://127.0.0.1:${port}`);
    assert.equal(same.opened, true);
    same.ws.close();

    const foreign = await connect("https://attacker.example");
    assert.equal(foreign.opened, false);
    assert.equal(foreign.status, 403);

    const absent = await connect();
    assert.equal(absent.opened, false);
    assert.equal(absent.status, 403);
  } finally {
    await app.close();
  }
});

test("explicit production origin allowlist supports a separate trusted frontend", async () => {
  const app = createApp({
    enforceOrigin: true,
    allowedOrigins: "https://roomquake.example",
  });
  const port = await listen(app);
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: "https://roomquake.example",
    });
    ws.once("open", () => resolve({ opened: true, ws }));
    ws.once("unexpected-response", (_req, res) =>
      resolve({ opened: false, status: res.statusCode }),
    );
  });
  try {
    assert.equal(result.opened, true);
    result.ws.close();
  } finally {
    await app.close();
  }
});
