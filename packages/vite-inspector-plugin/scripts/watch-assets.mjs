import { spawn } from "node:child_process";
import { existsSync, statSync, watch } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const watchedPaths = [
  resolve(repoRoot, "packages/editor/dist")
];

let copying = false;
let pending = false;
const activeWatchers = new Set();

pending = true;
await copyAssets();
watchExistingPaths();

console.log("[web-no-code] watching editor assets for plugin dist sync");

const interval = setInterval(watchExistingPaths, 1000);
process.on("SIGINT", () => {
  clearInterval(interval);
  process.exit(0);
});
process.on("SIGTERM", () => {
  clearInterval(interval);
  process.exit(0);
});

function scheduleCopy() {
  pending = true;
  setTimeout(copyAssets, 80);
}

async function copyAssets() {
  if (copying || !pending) return;
  copying = true;
  pending = false;

  const child = spawn(process.execPath, [resolve(packageRoot, "scripts/copy-assets.mjs")], {
    stdio: "inherit"
  });

  await new Promise((resolveCopy, rejectCopy) => {
    child.on("error", rejectCopy);
    child.on("exit", (code) => {
      if (code) rejectCopy(new Error(`copy-assets exited with code ${code}`));
      else resolveCopy();
    });
  }).catch((error) => {
    console.warn(`[web-no-code] asset sync failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  copying = false;
  if (pending) await copyAssets();
}

function watchExistingPaths() {
  for (const path of watchedPaths) {
    if (activeWatchers.has(path) || !existsSync(path)) continue;
    const options = statSync(path).isDirectory() ? { recursive: true } : {};
    watch(path, options, scheduleCopy);
    activeWatchers.add(path);
    scheduleCopy();
  }
}
