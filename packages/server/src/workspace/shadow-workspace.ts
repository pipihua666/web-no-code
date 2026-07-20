import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import { pathExists, safeResolve } from "../codex/utils";

const ignoredNames = new Set([
  ".git",
  "node_modules",
  "dist",
  ".vite",
  ".next",
  ".nuxt",
  "coverage",
  ".turbo",
  ".cache"
]);

export type ShadowWorkspace = {
  id: string;
  realRoot: string;
  shadowRoot: string;
};

const shadows = new Map<string, ShadowWorkspace>();

export async function createShadowWorkspace(realRoot: string): Promise<ShadowWorkspace> {
  const shadowRoot = await mkdtemp(join(tmpdir(), "web-no-code-shadow-"));
  await cp(realRoot, shadowRoot, {
    recursive: true,
    filter: (source) => !ignoredNames.has(source.split("/").at(-1) || "")
  });
  const id = Buffer.from(`${realRoot}:${shadowRoot}`).toString("base64url");
  const shadow = { id, realRoot, shadowRoot };
  shadows.set(id, shadow);
  return shadow;
}

export function getShadowWorkspace(id: string) {
  return shadows.get(id) || null;
}

export async function disposeShadowWorkspace(id: string) {
  const shadow = shadows.get(id);
  if (!shadow) return;
  shadows.delete(id);
  await rm(shadow.shadowRoot, { recursive: true, force: true });
}

export async function disposeAllShadowWorkspaces() {
  const ids = Array.from(shadows.keys());
  await Promise.all(ids.map((id) => disposeShadowWorkspace(id)));
}

export async function diffShadowFile(shadow: ShadowWorkspace, relativeFile: string) {
  const realPath = safeResolve(shadow.realRoot, relativeFile);
  const shadowPath = safeResolve(shadow.shadowRoot, relativeFile);
  const [realExists, shadowExists] = await Promise.all([pathExists(realPath), pathExists(shadowPath)]);
  const realContent = realExists ? await readFile(realPath, "utf8") : "";
  const shadowContent = shadowExists ? await readFile(shadowPath, "utf8") : "";
  return createTwoFilesPatch(
    relative(shadow.realRoot, realPath),
    relative(shadow.shadowRoot, shadowPath),
    realContent,
    shadowContent,
    "real",
    "shadow"
  );
}

export async function diffShadowWorkspace(shadow: ShadowWorkspace) {
  const files = await listComparableFiles(shadow.shadowRoot);
  const changedFiles: string[] = [];
  const patches: string[] = [];

  for (const file of files) {
    const realPath = safeResolve(shadow.realRoot, file);
    const shadowPath = safeResolve(shadow.shadowRoot, file);
    const [realExists, shadowExists] = await Promise.all([pathExists(realPath), pathExists(shadowPath)]);
    if (!shadowExists) continue;

    const [realContent, shadowContent] = await Promise.all([
      realExists ? readFile(realPath, "utf8") : Promise.resolve(""),
      readFile(shadowPath, "utf8")
    ]);

    if (realContent !== shadowContent) {
      changedFiles.push(file);
      patches.push(createTwoFilesPatch(file, file, realContent, shadowContent, "real", "shadow"));
    }
  }

  return {
    changedFiles,
    diff: patches.join("\n")
  };
}

export async function applyShadowFile(shadow: ShadowWorkspace, relativeFile: string) {
  const realPath = safeResolve(shadow.realRoot, relativeFile);
  const shadowPath = safeResolve(shadow.shadowRoot, relativeFile);
  const content = await readFile(shadowPath, "utf8");
  await mkdir(dirname(realPath), { recursive: true });
  await writeFile(realPath, content, "utf8");
}

export async function applyShadowFiles(shadow: ShadowWorkspace, files: string[]) {
  for (const file of files) {
    await applyShadowFile(shadow, file);
  }
}

async function listComparableFiles(root: string) {
  const files: string[] = [];
  await walk(root, "");
  return files.sort();

  async function walk(base: string, relativeDir: string) {
    const dir = safeResolve(base, relativeDir);
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue;
      const relativePath = join(relativeDir, entry.name);
      const fullPath = safeResolve(base, relativePath);

      if (entry.isDirectory()) {
        await walk(base, relativePath);
      } else if (entry.isFile() && isComparableFile(relativePath)) {
        const info = await stat(fullPath);
        if (info.size <= 1024 * 1024) {
          files.push(relativePath);
        }
      }
    }
  }
}

function isComparableFile(path: string) {
  return /\.(vue|tsx?|jsx?|css|scss|sass|less|html|json|md|svg)$/i.test(path);
}
