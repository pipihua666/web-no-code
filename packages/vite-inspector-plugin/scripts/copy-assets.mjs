import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const editorDist = resolve(repoRoot, "packages/editor/dist");
const pluginDist = resolve(packageRoot, "dist");
const targetDir = resolve(pluginDist, "editor");
const lockDir = resolve(packageRoot, ".copy-assets.lock");

const releaseLock = await acquireCopyLock();
try {
  await mkdir(pluginDist, { recursive: true });
  if (existsSync(editorDist)) {
    await syncEditorAssets();
  } else {
    console.warn("[web-no-code] skipped editor asset copy because packages/editor/dist does not exist yet");
  }
} finally {
  await releaseLock();
}

async function syncEditorAssets() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(targetDir, { recursive: true, force: true });
      await cp(editorDist, targetDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isTransientCopyError(error) || attempt === 2) throw error;
      await delay(80);
    }
  }
}

async function acquireCopyLock() {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockDir);
      return () => rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      try {
        const lock = await stat(lockDir);
        if (Date.now() - lock.mtimeMs > 30000) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (!isErrorCode(lockError, "ENOENT")) throw lockError;
      }
      await delay(50);
    }
  }
  throw new Error("Timed out waiting for the editor asset copy lock");
}

function isTransientCopyError(error) {
  return isErrorCode(error, "EEXIST") || isErrorCode(error, "ENOENT");
}

function isErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
