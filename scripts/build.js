import { cp, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
for (const file of [
  "server.js",
  "lib/signal.js",
  "lib/session.js",
  "lib/transport.js",
  "public/app.js",
])
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
for (const file of [
  "public",
  "lib",
  "server.js",
  "package.json",
  "package-lock.json",
])
  await cp(file, `dist/${file}`, { recursive: true });
console.log(
  "Validated JavaScript and assembled dist/. Run node dist/server.js.",
);
