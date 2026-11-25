import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const jsFiles = ["server.js"];
for (const dir of ["lib", "public"]) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      jsFiles.push(`${dir}/${entry.name}`);
    }
  }
}

for (const file of jsFiles) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
for (const file of [
  "public",
  "lib",
  "server.js",
  "package.json",
  "package-lock.json",
]) {
  await cp(file, `dist/${file}`, { recursive: true });
}
console.log(
  `Validated ${jsFiles.length} JavaScript files and assembled dist/. Run node dist/server.js.`,
);
