import express from "express";
import multer from "multer";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { addEventClient } from "./events";
import { codexBridge } from "./codex/bridge";
import type { ProviderMode } from "./codex/types";
import {
  commitStylePatch,
  commitTextPatch,
  previewStylePatch,
  previewTextPatch,
  replaceAsset,
  saveAsset
} from "./workspace/patch-engine";
import { disposeAllShadowWorkspaces } from "./workspace/shadow-workspace";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const preferredPort = Number(process.env.WEB_NO_CODE_SERVER_PORT || 4317);
const editorDist = resolveEditorDist();
type TargetAlias = { find: string; replacement: string };
type TargetWidth = 375 | 750 | "full";
type RegisteredTarget = { root: string; url: string; width?: TargetWidth; aliases?: TargetAlias[]; updatedAt: number };

const targets: RegisteredTarget[] = [];
const codexAttachmentsDir = join(tmpdir(), "web-no-code-codex-attachments");
let shuttingDown = false;
let httpServer: Server | null = null;
registerTargetFromEnv();

app.use(express.json({ limit: "8mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    apiVersion: 2,
    capabilities: ["codex-steer"],
    cwd: process.cwd(),
    editorReady: Boolean(editorDist),
    editorDist: editorDist || null
  });
});

app.get("/events", (_request, response) => {
  addEventClient(response);
});

app.get("/api/targets", (request, response) => {
  const root = String(request.query.root || "");
  const filteredTargets = root ? targets.filter((target) => target.root === root) : targets;
  response.json({ targets: filteredTargets });
});

app.post("/api/targets/register", (request, response) => {
  const root = String(request.body.root || "");
  const url = String(request.body.url || "");
  const width = normalizeTargetWidth(request.body.width);
  const aliases = normalizeTargetAliases(request.body.aliases);
  if (!root || !url) {
    response.status(400).json({ error: "Missing target root or url" });
    return;
  }

  const target = { root, url, width, aliases, updatedAt: Date.now() };
  const existingIndex = targets.findIndex((item) => item.root === root);
  if (existingIndex >= 0) targets.splice(existingIndex, 1);
  targets.unshift(target);
  targets.splice(10);
  response.json({ target });
});

function registerTargetFromEnv() {
  const root = process.env.WEB_NO_CODE_TARGET_ROOT;
  const url = process.env.WEB_NO_CODE_TARGET_URL;
  if (!root || !url) return;
  const width = normalizeTargetWidth(process.env.WEB_NO_CODE_TARGET_WIDTH);
  targets.unshift({ root, url, width, updatedAt: Date.now() });
}

function normalizeTargetWidth(value: unknown): TargetWidth | undefined {
  if (value === "full") return "full";
  const width = Number(value);
  if (width === 375 || width === 750) return width;
  return undefined;
}

function normalizeTargetAliases(value: unknown): TargetAlias[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      find: String(item?.find || ""),
      replacement: String(item?.replacement || "")
    }))
    .filter((item) => item.find && item.replacement);
}

app.get("/api/codex/status", async (request, response) => {
  try {
    const mode = parseMode(request.query.mode);
    response.json(await codexBridge.status(mode));
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.get("/api/codex/models", async (request, response) => {
  try {
    const mode = parseMode(request.query.mode);
    response.json({ models: await codexBridge.listModels(mode) });
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.get("/api/codex/skills", async (_request, response) => {
  try {
    response.json({ skills: await listCodexSkills() });
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/codex/thread", async (request, response) => {
  try {
    response.json(
      await codexBridge.startThread({
        cwd: String(request.body.cwd || process.cwd()),
        sandbox: request.body.sandbox || "workspace-write",
        model: request.body.model || undefined,
        reasoningEffort: normalizeOptionalString(request.body.reasoningEffort),
        developerInstructions: normalizeOptionalString(request.body.developerInstructions),
        workspaceMode: request.body.workspaceMode === "direct" ? "direct" : "shadow",
        mode: "app-server"
      })
    );
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/codex/thread/resume", async (request, response) => {
  try {
    response.json(
      await codexBridge.resumeThread(String(request.body.threadId || ""), {
        cwd: String(request.body.cwd || process.cwd()),
        sandbox: request.body.sandbox || "workspace-write",
        model: request.body.model || undefined,
        reasoningEffort: normalizeOptionalString(request.body.reasoningEffort),
        workspaceMode: request.body.workspaceMode === "direct" ? "direct" : "shadow",
        mode: "app-server"
      })
    );
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/codex/turn", async (request, response) => {
  try {
    response.json(
      await codexBridge.runTurn({
        threadId: String(request.body.threadId || ""),
        input: String(request.body.input || ""),
        attachments: Array.isArray(request.body.attachments) ? request.body.attachments : [],
        selectedElementContext: request.body.selectedElementContext || null
      })
    );
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/codex/steer", async (request, response) => {
  try {
    response.json(
      await codexBridge.steerTurn({
        threadId: String(request.body.threadId || ""),
        input: String(request.body.input || ""),
        attachments: Array.isArray(request.body.attachments) ? request.body.attachments : [],
        selectedElementContext: request.body.selectedElementContext || null
      })
    );
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.get("/api/codex/thread/:threadId/status", (request, response) => {
  response.json(codexBridge.getTurnStatus(request.params.threadId));
});

app.get("/api/codex/diff/:threadId", async (request, response) => {
  try {
    response.json({ diff: await codexBridge.getDiff(request.params.threadId) });
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/codex/apply", async (request, response) => {
  try {
    response.json(await codexBridge.applyThread(String(request.body.threadId || "")));
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/codex/interrupt", async (request, response) => {
  try {
    await codexBridge.interrupt(String(request.body.threadId || ""));
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/patch/style/preview", async (request, response) => {
  try {
    response.json(await previewStylePatch(request.body));
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/patch/style/apply", async (request, response) => {
  try {
    response.json(await commitStylePatch(request.body));
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/patch/text/preview", async (request, response) => {
  try {
    response.json(await previewTextPatch(request.body));
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/patch/text/apply", async (request, response) => {
  try {
    response.json(await commitTextPatch(request.body));
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/codex/attachments", upload.single("attachment"), async (request, response) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: "Missing attachment file" });
      return;
    }
    if (!request.file.mimetype.startsWith("image/")) {
      response.status(400).json({ error: "Only image attachments are supported" });
      return;
    }
    const extension = extensionFromUpload(request.file.originalname, request.file.mimetype);
    const filename = `codex-attachment-${nanoid(8)}${extension}`;
    const path = join(codexAttachmentsDir, filename);
    await mkdir(codexAttachmentsDir, { recursive: true });
    await writeFile(path, request.file.buffer);
    response.json({
      attachment: {
        type: "localImage",
        path,
        name: request.file.originalname || filename
      }
    });
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/assets", upload.single("asset"), async (request, response) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: "Missing asset file" });
      return;
    }
    response.json(
      await saveAsset(
        String(request.body.root || process.cwd()),
        request.file.originalname,
        request.file.buffer
      )
    );
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.post("/api/assets/replace", upload.single("asset"), async (request, response) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: "Missing asset file" });
      return;
    }
    const target = String(request.body.target || "");
    if (!target) {
      response.status(400).json({ error: "Missing target asset path" });
      return;
    }
    response.json(
      await replaceAsset(
        String(request.body.root || process.cwd()),
        target,
        request.file.buffer,
        parseStringArray(request.body.targets)
      )
    );
  } catch (error) {
    response.status(500).json(errorPayload(error));
  }
});

app.use("/api", (request, response) => {
  response.status(404).json({ error: `API route not found: ${request.method} ${request.originalUrl}` });
});

if (editorDist) {
  app.use(express.static(editorDist));
  app.use((request, response) => {
    if (!acceptsHtml(request)) {
      response.status(404).send("Web No Code asset not found");
      return;
    }
    const indexFile = resolve(editorDist, "index.html");
    response.sendFile(indexFile, (error) => {
      if (!error || response.headersSent) return;
      const statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
      response.status(statusCode).send(error.message || "Web No Code editor asset not found");
    });
  });
} else {
  app.use((_request, response) => {
    response.status(503).send("Web No Code editor assets are not built. Run `pnpm --dir packages/editor build` or `pnpm dev` first.");
  });
}

void listenWithPortFallback(preferredPort).then(({ server, port }) => {
  httpServer = server;
  console.log(`web-no-code server listening on http://127.0.0.1:${port}`);
  if (port !== preferredPort) {
    console.log(`web-no-code preferred port ${preferredPort} was unavailable; switched to ${port}`);
  }
  if (editorDist) console.log(`web-no-code editor assets served from ${editorDist}`);
  void warmupCodexAppServer();
});

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolveShutdown) => {
    if (httpServer) httpServer.close(() => resolveShutdown());
    else resolveShutdown();
    setTimeout(resolveShutdown, 1000).unref();
  });
  await codexBridge.dispose();
  await cleanupTemporaryFiles();
  process.exit(code);
}

async function cleanupTemporaryFiles() {
  await Promise.all([
    rm(codexAttachmentsDir, { recursive: true, force: true }),
    disposeAllShadowWorkspaces()
  ]);
}

async function warmupCodexAppServer() {
  const status = await codexBridge.warmup("app-server");
  if (status.available) {
    console.log(`web-no-code codex app-server ready${status.codexVersion ? ` (${status.codexVersion})` : ""}`);
    return;
  }
  console.warn(`web-no-code codex app-server unavailable: ${status.reason || "unknown error"}`);
}

async function listenWithPortFallback(startPort: number) {
  let port = startPort;
  while (port <= 65535) {
    try {
      const server = await listenOnPort(port);
      return { server, port };
    } catch (error) {
      if (!isPortUnavailable(error)) throw error;
      port += 1;
    }
  }
  throw new Error(`No available port found from ${startPort} to 65535`);
}

function listenOnPort(port: number) {
  const server = createServer(app);
  return new Promise<Server>((resolveListen, rejectListen) => {
    const onError = (error: Error & { code?: string }) => {
      server.close();
      rejectListen(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen(server);
    });
  });
}

function isPortUnavailable(error: unknown) {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "EADDRINUSE";
}

function acceptsHtml(request: express.Request) {
  return String(request.headers.accept || "").includes("text/html");
}

function parseMode(value: unknown): ProviderMode {
  return "app-server";
}

function errorPayload(error: unknown) {
  return {
    error: error instanceof Error ? error.message : String(error)
  };
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseStringArray(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function extensionFromUpload(name: string, mimeType: string) {
  const match = name.match(/\.[A-Za-z0-9]+$/);
  if (match) return match[0];
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/svg+xml") return ".svg";
  return ".png";
}

async function listCodexSkills() {
  const roots = [join(homedir(), ".codex/skills")];
  const skills = new Map<string, { name: string; description: string; path: string }>();

  for (const root of roots) {
    for (const skill of await readSkillsFromRoot(root)) {
      if (!skills.has(skill.name)) skills.set(skill.name, skill);
    }
  }

  return Array.from(skills.values()).sort((left, right) => left.name.localeCompare(right.name));
}

async function readSkillsFromRoot(root: string) {
  if (!existsSync(root)) return [];
  const skills: Array<{ name: string; description: string; path: string }> = [];
  const visited = new Set<string>();

  async function visit(directory: string) {
    const directoryStat = await stat(directory).catch(() => null);
    if (!directoryStat?.isDirectory()) return;
    const resolvedDirectory = await realpath(directory).catch(() => resolve(directory));
    if (visited.has(resolvedDirectory)) return;
    visited.add(resolvedDirectory);

    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const skillEntry = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (skillEntry) {
      const skillPath = join(directory, skillEntry.name);
      const content = await readFile(skillPath, "utf8").catch(() => "");
      if (content) skills.push(parseSkillMarkdown(content, skillPath, dirnameName(directory)));
      return;
    }

    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".system" || entry.name === "node_modules") continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      await visit(join(directory, entry.name));
    }
  }

  await visit(root);
  return skills;
}

function dirnameName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || "skill";
}

function parseSkillMarkdown(content: string, path: string, fallbackName: string) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  const meta = frontmatter?.[1] || "";
  const name = meta.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallbackName;
  const description = meta.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
  return { name, description, path };
}

function resolveEditorDist() {
  const configured = process.env.WEB_NO_CODE_EDITOR_DIST;
  const executableDir = dirname(resolve(process.argv[1] || process.cwd()));
  const candidates = [
    configured,
    resolve(executableDir, "editor"),
    resolve(process.cwd(), "../editor/dist"),
    resolve(process.cwd(), "packages/editor/dist")
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolve(resolved, "index.html"))) return resolved;
  }

  return "";
}
