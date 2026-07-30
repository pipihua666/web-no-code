import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TraceMap, originalPositionFor, type EncodedSourceMap } from "@jridgewell/trace-mapping";
import type { ViteDevServer, Plugin, PluginOption, ResolvedConfig } from "vite";

const moduleDir = resolveModuleDir();
const requireFromModule = createRequire(resolve(moduleDir, "index.js"));
const vueInspectorListenersId = toViteFsModuleId(
  requireFromModule.resolve("vite-plugin-vue-inspector/client/listeners")
);

export enum WebNoCodePreviewWidth {
  Width375 = 375,
  Width750 = 750,
  Full = "full"
}

export type WebNoCodeInspectorOptions = {
  enabled?: boolean;
  vueInspector?: boolean;
  autoStart?: boolean;
  open?: boolean;
  width?: WebNoCodePreviewWidth;
  serverPort?: number;
  serverUrl?: string;
  workspaceRoot?: string;
  cli?: string | WebNoCodeCliCommand;
};

type WebNoCodeCliCommand = {
  command: string;
  args?: string[];
};

type TargetPayload = {
  root: string;
  url: string;
  width?: WebNoCodePreviewWidth;
  aliases?: TargetAlias[];
};

type TargetAlias = {
  find: string;
  replacement: string;
};

function normalizePluginList(option: PluginOption): Plugin[] {
  if (!option) return [];
  if (Array.isArray(option)) return option.flatMap((item) => normalizePluginList(item));
  if (typeof option === "object" && "name" in option) return [option as Plugin];
  return [];
}

async function loadVueInspectorPlugins(): Promise<PluginOption[]> {
  const createVueInspector = resolveVueInspectorFactory(await import("vite-plugin-vue-inspector"));
  return normalizePluginList(createVueInspector({
    enabled: false,
    toggleComboKey: false,
    toggleButtonVisibility: "never",
    disableInspectorOnEditorOpen: false,
    viteDevtools: false
  }));
}

export function webNoCodeInspector(options: WebNoCodeInspectorOptions = {}): PluginOption[] {
  if (options.enabled === false) return [];

  const vueInspectorEnabled = options.vueInspector ?? true;
  const autoStart = options.autoStart ?? true;
  const shouldOpen = options.open ?? true;
  const width = normalizePreviewWidth(options.width);
  const serverPort = options.serverPort || 4317;
  const configuredServerUrl = (options.serverUrl || `http://127.0.0.1:${serverPort}`).replace(/\/$/, "");
  const canSwitchPort = !options.serverUrl;
  const cli = normalizeCli(options.cli);
  let root = resolveWorkspaceRoot(options.workspaceRoot);
  let aliases: TargetAlias[] = [];
  let webNoCodeProcess: ChildProcess | null = null;
  let cleanupRegistered = false;

  const cleanup = () => {
    if (!webNoCodeProcess) return;
    terminateProcess(webNoCodeProcess);
    webNoCodeProcess = null;
  };

  const plugins: PluginOption[] = [];
  if (vueInspectorEnabled) {
    plugins.push(loadVueInspectorPlugins());
  }

  plugins.push({
    name: "web-no-code-inspector",
    apply: "serve",
    configResolved(config) {
      root = resolveWorkspaceRoot(options.workspaceRoot);
      aliases = normalizeViteAliases(config, root);
    },
    configureServer(server) {
      server.middlewares.use("/@web-no-code/source/element", async (request, response) => {
        try {
          const payload = JSON.parse(await readRequestBody(request));
          const viteSourceFile = await resolveViteSourceFile(server, payload?.sourceFileHint);
          const source = locateElementSource(root, payload || {}, aliases, viteSourceFile);
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ source }));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });

      server.middlewares.use("/@web-no-code/source/raw", async (request, response) => {
        try {
          const url = new URL(request.url || "", "http://web-no-code.local");
          const file = url.searchParams.get("file") || "";
          const viteSourceFile = await resolveViteSourceFile(server, file);
          const resolvedFile = viteSourceFile || resolveSourceFileHint(root, file, aliases);
          if (!resolvedFile || (!viteSourceFile && !isSourceFileInRoot(root, resolvedFile))) {
            response.statusCode = 404;
            response.end("");
            return;
          }

          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end(readFileSync(resolvedFile, "utf8"));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });

      server.middlewares.use("/@web-no-code/source-map/original-position", async (request, response) => {
        try {
          const url = new URL(request.url || "", "http://web-no-code.local");
          const id = url.searchParams.get("id") || "";
          const line = Number(url.searchParams.get("line") || 0);
          const column = Number(url.searchParams.get("column") || 0);
          if (!id || !line) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: "Missing id or line" }));
            return;
          }

          const position = await locateOriginalStylePosition(server, id, line, column);
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ position }));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });

      server.httpServer?.once("listening", async () => {
        const targetUrl =
          server.resolvedUrls?.local[0] ||
          server.resolvedUrls?.network[0] ||
          inferServerUrl(server.config.server.host, server.config.server.port);
        const target = {
          root,
          url: targetUrl,
          width,
          aliases
        };
        let activeServerUrl = configuredServerUrl;

        if (autoStart) {
          const result = await ensureWebNoCodeServer({
            cli,
            serverUrl: configuredServerUrl,
            serverPort,
            canSwitchPort,
            target,
            width,
            shouldOpen,
            logger: server
          });
          webNoCodeProcess = result.process;
          activeServerUrl = result.serverUrl;
        }

        registerTarget(activeServerUrl, target);
      });

      server.httpServer?.once("close", cleanup);
      if (!cleanupRegistered) {
        cleanupRegistered = true;
        process.once("SIGINT", cleanup);
        process.once("SIGTERM", cleanup);
        process.once("exit", cleanup);
      }
    },
    transformIndexHtml(html) {
      return html.replace(
        "</head>",
        `<script type="module" src="/@web-no-code/inspector-runtime?v=${Date.now()}"></script></head>`
      );
    },
    resolveId(id) {
      if (id.startsWith("/@web-no-code/inspector-runtime")) return "/@web-no-code/inspector-runtime";
      return null;
    },
    load(id) {
      if (id !== "/@web-no-code/inspector-runtime") return null;
      return runtimeSource
        .replace("__WEB_NO_CODE_PROJECT_INFO__", JSON.stringify({ root, aliases }))
        .replace("__WEB_NO_CODE_VUE_INSPECTOR_LISTENERS_ID__", JSON.stringify(vueInspectorListenersId))
        .replace("__WEB_NO_CODE_HMR__", ["import", "meta", "hot"].join("."));
    }
  });
  return plugins;
}

export default webNoCodeInspector;

type VueInspectorFactory = (options: Record<string, unknown>) => PluginOption;

function resolveVueInspectorFactory(moduleValue: unknown): VueInspectorFactory {
  const firstDefault =
    moduleValue && typeof moduleValue === "object" && "default" in moduleValue
      ? (moduleValue as { default: unknown }).default
      : moduleValue;
  const secondDefault =
    firstDefault && typeof firstDefault === "object" && "default" in firstDefault
      ? (firstDefault as { default: unknown }).default
      : firstDefault;

  if (typeof secondDefault !== "function") {
    throw new TypeError("vite-plugin-vue-inspector did not export a plugin factory");
  }
  return secondDefault as VueInspectorFactory;
}

function readRequestBody(request: { on: (event: string, handler: (chunk?: Buffer) => void) => void }) {
  return new Promise<string>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8") || "{}"));
    request.on("error", (error) => rejectBody(error));
  });
}

type ElementSourcePayload = {
  tagName?: string;
  selector?: string;
  contextSelector?: string;
  sourceFileHint?: string;
  sourceLineHint?: number;
  sourceColumnHint?: number;
  text?: string;
  attributes?: Record<string, string>;
  styles?: Record<string, string>;
};

function locateElementSource(
  root: string,
  payload: ElementSourcePayload,
  aliases: TargetAlias[] = [],
  viteSourceFile = ""
) {
  if (!root || !existsSync(root)) return null;
  const id = payload.attributes?.id || "";
  const classes = (payload.attributes?.class || "").split(/\s+/).filter(Boolean);
  const src = payload.attributes?.src || extractCssUrl(payload.styles?.["background-image"] || "");
  const srcBase = src.split(/[?#]/)[0].split("/").filter(Boolean).at(-1) || "";
  const text = (payload.text || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const selectorTail = (payload.selector || "").split(" > ").at(-1) || "";
  const selectorClasses = classes.length ? `.${classes.join(".")}` : "";
  const selectorContext = selectorContextFromCssPath(payload.selector || "", payload.contextSelector || "");
  let best: { file: string; line: number; column: number; score: number } | null = null;

  const hintedFile = viteSourceFile || resolveSourceFileHint(root, payload.sourceFileHint, aliases);
  if (hintedFile && payload.sourceLineHint) {
    return {
      file: hintedFile,
      line: payload.sourceLineHint,
      column: payload.sourceColumnHint || 1
    };
  }
  const sourceFiles = hintedFile ? [hintedFile] : listSourceFiles(root);
  for (const file of sourceFiles) {
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const score = scoreSourceLine(line, {
        id,
        classes,
        src,
        srcBase,
        text,
        selectorTail,
        selectorClasses,
        selectorContext,
        nearbyLines: lines.slice(Math.max(0, index - 20), index + 1)
      });
      if (!score) continue;
      const weightedScore = score + filePriority(file);
      if (!best || weightedScore > best.score) {
        best = {
          file,
          line: index + 1,
          column: Math.max(1, firstMatchColumn(line, [id, src, srcBase, text, ...classes, selectorClasses, selectorTail])),
          score: weightedScore
        };
      }
    }
  }

  return best ? { file: best.file, line: best.line, column: best.column } : null;
}

function listSourceFiles(root: string) {
  const files: string[] = [];
  const visit = (directory: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (/\.(vue|tsx?|jsx?|css|scss|sass|less|styl|stylus)$/.test(entry.name)) files.push(path);
    }
  };
  visit(root);
  return files;
}

export function resolveSourceFileHint(root: string, hint?: string, aliases: TargetAlias[] = []) {
  if (!hint) return "";
  const cleanHint = hint.replace(/^\/@fs\//, "/").split(/[?#]/)[0];
  const relativeHint = cleanHint.replace(/^\//, "");
  const aliasCandidates = aliases.flatMap((alias) => {
    if (!alias.replacement) return [];
    return [resolve(alias.replacement, relativeHint)];
  });
  const candidates = [
    cleanHint,
    cleanHint.startsWith("/") ? resolve(root, relativeHint) : "",
    cleanHint.startsWith("/") ? cleanHint : resolve(root, cleanHint),
    cleanHint.startsWith("/src/") ? resolve(root, cleanHint.slice(1)) : "",
    cleanHint.startsWith("src/") ? resolve(root, cleanHint) : "",
    ...aliasCandidates
  ].filter(Boolean);
  return candidates.find((file) => existsSync(file)) || "";
}

type ViteSourceResolver = Pick<ViteDevServer, "moduleGraph" | "pluginContainer">;

export async function resolveViteSourceFile(server: ViteSourceResolver, hint?: string) {
  if (!hint) return "";
  const module = await server.moduleGraph.getModuleByUrl(hint).catch(() => undefined);
  const moduleFile = existingSourceFile(module?.file || module?.id || "");
  if (moduleFile) return moduleFile;

  const resolved = await server.pluginContainer.resolveId(hint).catch(() => null);
  if (!resolved?.id) return "";
  const resolvedModule = server.moduleGraph.getModuleById(resolved.id);
  return existingSourceFile(resolvedModule?.file || resolvedModule?.id || "");
}

function existingSourceFile(value: string) {
  if (!value || value.startsWith("\0")) return "";
  const cleanValue = value.split(/[?#]/)[0];
  const file = cleanValue.startsWith("file://")
    ? fileURLToPath(cleanValue)
    : cleanValue.replace(/^\/@fs\//, "/");
  return existsSync(file) ? file : "";
}

function isSourceFileInRoot(root: string, file: string) {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(file);
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}/`);
}

function scoreSourceLine(
  line: string,
  tokens: {
    id: string;
    classes: string[];
    src: string;
    srcBase: string;
    text: string;
    selectorTail: string;
    selectorClasses: string;
    selectorContext: SelectorContext;
    nearbyLines: string[];
  }
) {
  let score = 0;
  if (tokens.id && (line.includes(`id="${tokens.id}"`) || line.includes(`id='${tokens.id}'`) || line.includes(`#${tokens.id}`))) {
    score += 100;
  }
  if (tokens.src && line.includes(tokens.src)) score += 100;
  if (tokens.srcBase && line.includes(tokens.srcBase)) score += 80;
  if (tokens.selectorClasses && line.includes(tokens.selectorClasses)) score += 70;
  if (tokens.selectorTail && line.includes(tokens.selectorTail)) score += 45;
  if (tokens.selectorContext.leafClasses.length && hasAllClassesInLine(line, tokens.selectorContext.leafClasses)) {
    score += 90;
  }
  if (
    tokens.selectorContext.parentClasses.length &&
    tokens.selectorContext.leafClasses.length &&
    hasAllClassesInLine(line, tokens.selectorContext.leafClasses) &&
    tokens.nearbyLines.some((nearbyLine) => hasAllClassesInLine(nearbyLine, tokens.selectorContext.parentClasses))
  ) {
    score += 160;
  }
  for (const className of tokens.classes) {
    if (line.includes(className)) score += /\bclass(Name)?=/.test(line) ? 45 : 24;
    if (line.includes(`.${className}`)) score += 36;
  }
  if (tokens.text && tokens.text.length >= 4 && line.replace(/\s+/g, " ").includes(tokens.text)) score += 70;
  return score;
}

type SelectorContext = {
  parentClasses: string[];
  leafClasses: string[];
};

function selectorContextFromCssPath(selector: string, contextSelector = ""): SelectorContext {
  if (contextSelector) {
    const contextParts = contextSelector.split(/\s+/).map((part) => part.trim()).filter(Boolean);
    const leafClasses = classNamesFromSelectorPart(contextParts.at(-1) || "");
    const parentClasses = classNamesFromSelectorPart(contextParts.at(-2) || "");
    if (leafClasses.length || parentClasses.length) return { parentClasses, leafClasses };
  }
  const parts = selector.split(" > ").map((part) => part.trim()).filter(Boolean);
  const leafClasses = classNamesFromSelectorPart(parts.at(-1) || "");
  const parentClasses = classNamesFromSelectorPart(parts.at(-2) || "");
  return { parentClasses, leafClasses };
}

function classNamesFromSelectorPart(part: string) {
  return Array.from(part.matchAll(/\.([A-Za-z0-9_-]+)/g), (match) => match[1]);
}

function hasAllClassesInLine(line: string, classes: string[]) {
  return classes.length > 0 && classes.every((className) => line.includes(className) || line.includes(`.${className}`));
}

function firstMatchColumn(line: string, values: string[]) {
  const positions = values
    .filter(Boolean)
    .map((value) => line.indexOf(value))
    .filter((index) => index >= 0);
  return positions.length ? Math.min(...positions) + 1 : 1;
}

function filePriority(file: string) {
  if (file.endsWith(".vue")) return 30;
  if (/\.(scss|sass|less|css)$/.test(file)) return 15;
  return 0;
}

function extractCssUrl(value: string) {
  const match = value.match(/url\((['"]?)(.*?)\1\)/);
  return match?.[2] || "";
}

async function locateOriginalStylePosition(server: ViteDevServer, id: string, line: number, column: number) {
  if (!isSafeServerStyleModuleId(id)) return null;
  let transformed;
  try {
    transformed = await server.transformRequest(toViteRequestId(id));
  } catch (_) {
    return null;
  }
  const map = transformed?.map || readInlineSourceMapFromCode(transformed?.code || "");
  if (!map) return null;

  const traced = originalPositionForSource(map as SourceMapLike, line, Math.max(0, column - 1), isEditableStyleSource);
  if (!traced?.source || !isEditableStyleSource(traced.source)) return null;

  return {
    file: traced.source,
    line: traced.line,
    column: traced.column == null ? undefined : traced.column + 1
  };
}

function toViteRequestId(id: string) {
  if (id.startsWith("/@fs/") || id.startsWith("/@id/") || id.startsWith("/src/")) return id;
  if (id.startsWith("/")) return `/@fs${id}`;
  return id;
}

function readInlineSourceMapFromCode(code: string) {
  const css = extractViteCss(code);
  if (!css) return null;
  return readInlineSourceMapFromCss(css);
}

function extractViteCss(source: string) {
  const match = source.match(/const\s+__vite__css\s*=\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/);
  if (!match) return "";
  try {
    return Function('"use strict";return (' + match[1] + ")")();
  } catch {
    return "";
  }
}

function readInlineSourceMapFromCss(css: string) {
  const match = css.match(/sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?(?:;base64)?,([^\s*]+)/);
  if (!match) return null;
  try {
    const payload = match[1];
    const json = /^[A-Za-z0-9+/=]+$/.test(payload) ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isEditableStyleSource(source: string) {
  const path = source.split(/[?#]/)[0].toLowerCase();
  return /\.(vue|css|scss|sass|less|styl|stylus|pcss|postcss)$/.test(path);
}

function isSafeServerStyleModuleId(id: string) {
  if (!id || id.startsWith("~") || id.startsWith("\0")) return false;
  if (/^[a-z]+:\/\//i.test(id) && !id.startsWith("file://")) return false;
  if (id.startsWith("/@fs/") || id.startsWith("/@id/") || id.startsWith("/src/")) return true;
  if (id.startsWith("/") || id.startsWith("src/") || id.startsWith("./") || id.startsWith("../")) return true;
  return false;
}

type SourceMapLike = EncodedSourceMap;

function originalPositionForSource(
  map: SourceMapLike,
  generatedLine: number,
  generatedColumn: number,
  acceptSource: (source: string) => boolean
) {
  if (!map.mappings) return null;
  const traced = originalPositionFor(new TraceMap({ ...map, version: 3 }), {
    line: generatedLine,
    column: generatedColumn,
    bias: -1
  });
  if (!traced.source || !acceptSource(traced.source) || traced.line == null || traced.column == null) return null;
  return {
    source: traced.source,
    line: traced.line,
    column: traced.column,
    name: traced.name || undefined
  };
}

function resolveWorkspaceRoot(workspaceRoot: string | undefined) {
  return workspaceRoot || process.env.WEB_NO_CODE_TARGET_ROOT || process.cwd();
}

function normalizePreviewWidth(width: WebNoCodeInspectorOptions["width"]): WebNoCodePreviewWidth | undefined {
  if (width === WebNoCodePreviewWidth.Width375) return width;
  if (width === WebNoCodePreviewWidth.Width750) return width;
  if (width === WebNoCodePreviewWidth.Full) return width;
  return undefined;
}

function normalizeViteAliases(config: ResolvedConfig, root: string): TargetAlias[] {
  const aliases = config.resolve.alias;
  const entries = Array.isArray(aliases)
    ? aliases
    : Object.entries(aliases || {}).map(([find, replacement]) => ({ find, replacement }));
  return entries
    .map((entry) => {
      if (!entry || entry.find instanceof RegExp) return null;
      const find = String(entry.find || "");
      const replacement = String(entry.replacement || "");
      if (!find || !replacement) return null;
      return {
        find,
        replacement: replacement.startsWith("/") ? replacement : resolve(root, replacement)
      };
    })
    .filter((entry): entry is TargetAlias => Boolean(entry));
}

function resolveModuleDir() {
  if (typeof __dirname === "string") return __dirname;

  const stack = new Error().stack || "";
  const fileUrl = stack.match(/file:\/\/[^\s)]+/)?.[0] || "";
  if (fileUrl) return dirname(fileURLToPath(fileUrl));

  return process.cwd();
}

function toViteFsModuleId(file: string) {
  return `/@fs/${file.replace(/\\/g, "/")}`;
}

function inferServerUrl(host: string | boolean | undefined, port: number | undefined) {
  const normalizedHost = !host || host === true || host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${normalizedHost}:${port || 5173}/`;
}

async function ensureWebNoCodeServer(options: {
  cli: Required<WebNoCodeCliCommand>;
  serverUrl: string;
  serverPort: number;
  canSwitchPort: boolean;
  target: TargetPayload;
  width?: WebNoCodePreviewWidth;
  shouldOpen: boolean;
  logger: ViteDevServer;
}) {
  if (await isServerReady(options.serverUrl)) {
    openEditor(options.serverUrl, options.shouldOpen, options.width);
    return { process: null, serverUrl: options.serverUrl };
  }

  if (await isApiReady(options.serverUrl)) {
    if (!options.canSwitchPort) {
      options.logger.config.logger.warn(
        `[web-no-code] ${options.serverUrl} is already running, but the editor UI is not available. Stop the stale process on port ${options.serverPort} and restart the Vite dev server.`
      );
      return { process: null, serverUrl: options.serverUrl };
    }
    options.logger.config.logger.warn(
      `[web-no-code] ${options.serverUrl} is occupied by an incomplete web-no-code server; trying another port.`
    );
  }

  const endpoint = options.canSwitchPort
    ? await resolveAvailableEndpoint(options.serverUrl, options.serverPort, options.logger)
    : { serverUrl: options.serverUrl, port: options.serverPort };

  const child = spawn(options.cli.command, [...options.cli.args, "serve"], {
    env: {
      ...process.env,
      WEB_NO_CODE_SERVER_PORT: String(endpoint.port),
      WEB_NO_CODE_TARGET_ROOT: options.target.root,
      WEB_NO_CODE_TARGET_URL: options.target.url,
      ...(options.width ? { WEB_NO_CODE_TARGET_WIDTH: String(options.width) } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout?.on("data", (data) => options.logger.config.logger.info(`[web-no-code] ${String(data).trim()}`));
  child.stderr?.on("data", (data) => options.logger.config.logger.warn(`[web-no-code] ${String(data).trim()}`));
  child.on("error", (error) => {
    options.logger.config.logger.warn(`[web-no-code] Failed to start ${options.cli.command}: ${error.message}`);
  });

  const ready = await waitForServer(endpoint.serverUrl);
  if (ready) {
    options.logger.config.logger.info(`[web-no-code] editor ready at ${endpoint.serverUrl}`);
    openEditor(endpoint.serverUrl, options.shouldOpen, options.width);
  } else {
    options.logger.config.logger.warn(`[web-no-code] editor server did not become ready at ${endpoint.serverUrl}`);
  }

  return { process: child, serverUrl: endpoint.serverUrl };
}

async function resolveAvailableEndpoint(serverUrl: string, preferredPort: number, logger: ViteDevServer) {
  const url = new URL(serverUrl);
  const host = url.hostname || "127.0.0.1";
  let port = preferredPort;
  while (port <= 65535) {
    const nextUrl = withPort(url, port);
    if (await isServerReady(nextUrl)) return { serverUrl: nextUrl, port };
    if (await isPortAvailable(host, port)) {
      if (port !== preferredPort) {
        logger.config.logger.info(`[web-no-code] port ${preferredPort} is unavailable; using ${nextUrl}`);
      }
      return { serverUrl: nextUrl, port };
    }
    port += 1;
  }
  throw new Error(`No available web-no-code server port found from ${preferredPort} to 65535`);
}

function withPort(url: URL, port: number) {
  const next = new URL(url.href);
  next.port = String(port);
  return next.href.replace(/\/$/, "");
}

function isPortAvailable(host: string, port: number) {
  return new Promise<boolean>((resolveAvailable) => {
    const probe = createServer();
    probe.once("error", () => resolveAvailable(false));
    probe.once("listening", () => {
      probe.close(() => resolveAvailable(true));
    });
    probe.listen(port, host);
  });
}

function terminateProcess(child: ChildProcess) {
  if (child.killed) return;
  child.kill("SIGTERM");
}

function normalizeCli(cli: WebNoCodeInspectorOptions["cli"]): Required<WebNoCodeCliCommand> {
  if (typeof cli === "string") {
    return {
      command: process.execPath,
      args: [cli]
    };
  }
  if (cli) {
    return {
      command: cli.command,
      args: cli.args || []
    };
  }
  return resolveDefaultCli();
}

function resolveDefaultCli(): Required<WebNoCodeCliCommand> {
  const distCli = resolve(moduleDir, "cli.js");
  if (existsSync(distCli)) {
    return {
      command: process.execPath,
      args: [distCli]
    };
  }
  return {
    command: "pnpm",
    args: ["tsx", resolve(moduleDir, "cli.ts")]
  };
}

async function isApiReady(serverUrl: string) {
  try {
    const response = await fetch(`${serverUrl}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function isServerReady(serverUrl: string) {
  try {
    const healthResponse = await fetch(`${serverUrl}/api/health`);
    if (!healthResponse.ok) return false;
    const health = (await healthResponse.json()) as { capabilities?: unknown };
    if (!Array.isArray(health.capabilities) || !health.capabilities.includes("codex-steer")) return false;
    const response = await fetch(`${serverUrl}/`);
    const contentType = response.headers.get("content-type") || "";
    return response.ok && contentType.includes("text/html");
  } catch {
    return false;
  }
}

async function waitForServer(serverUrl: string) {
  for (let index = 0; index < 60; index += 1) {
    if (await isServerReady(serverUrl)) return true;
    await new Promise((resolveReady) => setTimeout(resolveReady, 250));
  }
  return false;
}

function registerTarget(serverUrl: string, payload: TargetPayload) {
  fetch(`${serverUrl}/api/targets/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }).catch(() => {
    // The editor backend may not be running yet. The target can still be entered manually.
  });
}

function openEditor(serverUrl: string, shouldOpen: boolean, width?: WebNoCodePreviewWidth) {
  if (!shouldOpen) return;
  const editorUrl = new URL(serverUrl);
  if (width) editorUrl.searchParams.set("width", String(width));
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", editorUrl.href] : [editorUrl.href];
  spawn(opener, args, {
    stdio: "ignore",
    detached: true
  }).unref();
}

const runtimeSource = String.raw`
const PROJECT_INFO = __WEB_NO_CODE_PROJECT_INFO__;
const SOURCE_FILE_CACHE_LIMIT = 24;
const STYLE_MODULE_CACHE_LIMIT = 16;
const SOURCE_MAP_POSITION_CACHE_LIMIT = 1000;

const STATE = {
  enabled: false,
  temporaryMode: null,
  dragEnabled: false,
  hover: null,
  selected: null,
  overlay: null,
  badge: null,
  measureLayer: null,
  measuring: false,
  hoverFrame: 0,
  drag: null,
  suppressClickUntil: 0,
  vueInspectorListeners: null,
  vueInspectorListenersLoaded: false,
  styleModules: new Map(),
  sourceMapPositions: new Map(),
  sourceFiles: new Map(),
  selectedRefreshTimer: 0
};

function init() {
  STATE.overlay = document.createElement("div");
  STATE.overlay.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "pointer-events:none",
    "border:1.5px solid #2bd6a3",
    "box-shadow:0 0 0 99999px rgba(8, 12, 18, .18)",
    "background:rgba(43, 214, 163, .10)",
    "display:none"
  ].join(";");

  STATE.badge = document.createElement("div");
  STATE.badge.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "pointer-events:none",
    "background:#101820",
    "color:#d8fff3",
    "font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
    "max-width:min(420px, calc(100vw - 16px))",
    "overflow:hidden",
    "padding:4px 7px",
    "border-radius:4px",
    "box-shadow:0 8px 24px rgba(0,0,0,.24)",
    "text-overflow:ellipsis",
    "white-space:nowrap",
    "display:none"
  ].join(";");

  document.documentElement.appendChild(STATE.overlay);
  document.documentElement.appendChild(STATE.badge);
  STATE.measureLayer = document.createElement("div");
  STATE.measureLayer.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483646",
    "pointer-events:none",
    "display:none"
  ].join(";");
  document.documentElement.appendChild(STATE.measureLayer);
  window.addEventListener("message", handleMessage);
  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("mousedown", handleMouseDown, true);
  document.addEventListener("mouseup", handleMouseUp, true);
  document.addEventListener("mouseleave", handleMouseUp, true);
  document.addEventListener("click", handleClick, true);
  document.addEventListener("dblclick", handleDoubleClick, true);
  document.addEventListener("paste", handlePaste, true);
  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("keyup", handleKeyUp, true);
  installTouchBridge();
  installHmrUpdateFallback();
  watchDocumentTitle();
  watchLocation();
  window.addEventListener("scroll", refreshOverlay, true);
  window.addEventListener("resize", refreshOverlay);
  window.addEventListener("blur", () => {
    STATE.measuring = false;
    hideMeasurements();
  });

  postReady();
}

function installHmrUpdateFallback() {
  const hot = __WEB_NO_CODE_HMR__;
  if (!hot) return;
  let refreshTimer = 0;
  hot.on("file-changed", () => {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      STATE.styleModules.clear();
      STATE.sourceMapPositions.clear();
      STATE.sourceFiles.clear();
      if (STATE.selected) {
        post("selected", serializeElement(STATE.selected));
      }
    }, 80);
  });
}

function handleMessage(event) {
  const message = event.data || {};
  if (message.source !== "web-no-code-editor") return;
  if (message.type === "inspector:set-enabled") {
    STATE.enabled = !!message.enabled;
    STATE.dragEnabled = !!message.dragEnabled;
    updateDraggableCursor(STATE.hover || STATE.selected);
    if (!STATE.enabled) {
      STATE.hover = null;
      clearSelectedElement();
      releaseInspectorCaches();
    }
  }
  if (message.type === "inspector:style-preview") {
    applyStylePreview(message.property, message.value, message.selector);
  }
  if (message.type === "inspector:select-element") {
    selectElement(findElement(message.selector));
  }
  if (message.type === "inspector:clear-selected") {
    clearSelectedElement();
  }
  if (message.type === "inspector:ping") {
    postReady();
  }
}

function postReady() {
  post("ready", { ...PROJECT_INFO, url: location.href, title: document.title || "" });
}

function postTitleChange() {
  post("title-change", { title: document.title || "" });
}

function watchDocumentTitle() {
  const target = document.head || document.documentElement;
  if (!target || typeof MutationObserver === "undefined") return;
  let lastTitle = document.title || "";
  const observer = new MutationObserver(() => {
    const nextTitle = document.title || "";
    if (nextTitle === lastTitle) return;
    lastTitle = nextTitle;
    postTitleChange();
  });
  observer.observe(target, { childList: true, characterData: true, subtree: true });
}

function watchLocation() {
  let lastUrl = location.href;
  const postUrlChange = () => {
    const nextUrl = location.href;
    if (nextUrl === lastUrl) return;
    lastUrl = nextUrl;
    post("url-change", { url: nextUrl });
  };

  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      postUrlChange();
      return result;
    };
  }

  window.addEventListener("popstate", postUrlChange);
  window.addEventListener("hashchange", postUrlChange);
}

function applyStylePreview(property, value, selector) {
  if (!property) return;
  const element = STATE.selected || findElement(selector);
  if (!element) {
    post("status", { message: "No selected element available for style update" });
    return;
  }
  STATE.selected = element;
  element.style.setProperty(property, value, "important");
  drawOverlay(element, true);
  post("status", { message: "Style updated in preview: " + property });
}

function handlePaste(event) {
  const files = imageFilesFromClipboard(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  Promise.all(files.map(fileToPayload))
    .then((images) => {
      post("clipboard-images", {
        images: images.filter(Boolean)
      });
    })
    .catch((error) => {
      post("status", { message: "Clipboard image read failed: " + (error?.message || error) });
    });
}

function handleKeyDown(event) {
  if (isTypingTarget(event.target)) return;
  if (event.ctrlKey && !event.metaKey) {
    const key = event.key.toLowerCase();
    if (key === "c" || key === "d" || key === "s") {
      event.preventDefault();
      event.stopPropagation();
      post("shortcut", { shortcut: key === "c" ? "select" : key === "d" ? "drag" : "open-source" });
      return;
    }
  }
  const temporaryMode = temporaryModeFromEvent(event);
  if (temporaryMode) {
    STATE.temporaryMode = temporaryMode;
    updateDraggableCursor(STATE.hover || STATE.selected);
    post("temporary-inspector", { active: true, mode: temporaryMode });
    return;
  }
}

function handleKeyUp(event) {
  const mode = temporaryModeFromKey(event.key);
  if (!mode || STATE.temporaryMode !== mode) return;
  STATE.temporaryMode = null;
  updateDraggableCursor(STATE.hover || STATE.selected);
  if (!STATE.enabled) {
    STATE.hover = null;
    hideOverlay();
  }
  post("temporary-inspector", { active: false, mode });
  STATE.measuring = false;
  hideMeasurements();
}

function temporaryModeFromEvent(event) {
  if (event.repeat || event.metaKey || event.ctrlKey) return null;
  if ((event.key === "Alt" || event.key === "Option") && event.altKey) {
    return "select";
  }
  return null;
}

function temporaryModeFromKey(key) {
  if (key === "Alt" || key === "Option") return STATE.temporaryMode || null;
  return null;
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

function imageFilesFromClipboard(data) {
  if (!data) return [];
  const files = Array.from(data.files || []).filter((file) => file.type && file.type.startsWith("image/"));
  const itemFiles = Array.from(data.items || [])
    .filter((item) => item.kind === "file" && item.type && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  return dedupeFiles(files.concat(itemFiles));
}

function dedupeFiles(files) {
  const unique = new Map();
  for (const file of files) {
    unique.set([file.name, file.size, file.type].join(":"), file);
  }
  return Array.from(unique.values());
}

function fileToPayload(file) {
  return new Promise((resolvePayload, rejectPayload) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolvePayload({
        name: file.name || "pasted-image." + extensionFromMimeType(file.type),
        type: file.type || "image/png",
        dataUrl: String(reader.result || "")
      });
    };
    reader.onerror = () => rejectPayload(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

function extensionFromMimeType(type) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/svg+xml") return "svg";
  return (type || "image/png").split("/")[1] || "png";
}

function findElement(selector) {
  if (!selector) return null;
  try {
    return document.querySelector(selector);
  } catch (_) {
    return null;
  }
}

function handleMouseMove(event) {
  if (!isInspectorActive()) return;
  if (STATE.drag) {
    updateDrag(event);
    return;
  }
  const target = event.target;
  if (!isInspectable(target)) return;
  STATE.hover = target;
  if (STATE.hoverFrame) return;
  STATE.hoverFrame = requestAnimationFrame(() => {
    STATE.hoverFrame = 0;
    const hover = STATE.hover;
    if (!isInspectorActive() || STATE.drag || !isInspectable(hover)) return;
    drawOverlay(hover, STATE.selected === hover);
    updateDraggableCursor(hover);
  });
}

function handleMouseDown(event) {
  if (!isInspectorActive() || event.button !== 0) return;
  if (!isDragActive()) return;
  const target = event.target;
  if (!isInspectable(target) || target !== STATE.selected) return;
  const computed = getComputedStyle(target);
  if (!isDraggablePosition(computed.position)) return;

  const rect = target.getBoundingClientRect();
  const left = parseCssPixels(computed.left, rect.left);
  const top = parseCssPixels(computed.top, rect.top);
  STATE.drag = {
    element: target,
    context: serializeElement(target),
    startClientX: event.clientX,
    startClientY: event.clientY,
    startLeft: left,
    startTop: top,
    lastLeft: left,
    lastTop: top,
    moved: false
  };
  document.documentElement.style.cursor = "move";
  event.preventDefault();
  event.stopPropagation();
}

function handleMouseUp(event) {
  if (!STATE.drag) return;
  const drag = STATE.drag;
  STATE.drag = null;
  document.documentElement.style.cursor = "";
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!drag.moved) return;
  STATE.suppressClickUntil = Date.now() + 250;
  drawOverlay(drag.element, true);
  const payload = {
    selector: cssPath(drag.element),
    left: Math.round(drag.lastLeft) + "px",
    top: Math.round(drag.lastTop) + "px",
    context: drag.context
  };
  post("style-position-commit", payload);
}

function updateDrag(event) {
  const drag = STATE.drag;
  if (!drag) return;
  const left = drag.startLeft + event.clientX - drag.startClientX;
  const top = drag.startTop + event.clientY - drag.startClientY;
  drag.lastLeft = left;
  drag.lastTop = top;
  drag.moved = drag.moved || Math.abs(event.clientX - drag.startClientX) > 1 || Math.abs(event.clientY - drag.startClientY) > 1;
  drag.element.style.left = Math.round(left) + "px";
  drag.element.style.top = Math.round(top) + "px";
  drawOverlay(drag.element, true);
  event.preventDefault();
  event.stopPropagation();
}

function handleClick(event) {
  if (!isInspectorActive()) return;
  if (STATE.drag) return;
  if (Date.now() < STATE.suppressClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const target = event.target;
  if (!isInspectable(target)) return;
  event.preventDefault();
  event.stopPropagation();
  selectElement(target);
}

function handleDoubleClick(event) {
  if (!isInspectorActive() || STATE.drag) return;
  const below = elementBelowPoint(event.clientX, event.clientY, event.target);
  if (below) {
    event.preventDefault();
    event.stopPropagation();
    selectElement(below);
    return;
  }
  const root = deepestSelectableParent(event.target) || STATE.selected;
  const child = findDeepestChildAtPoint(root, event.clientX, event.clientY);
  if (!child) return;
  event.preventDefault();
  event.stopPropagation();
  selectElement(child);
}

function elementBelowPoint(x, y, currentTarget) {
  const hidden = [];
  try {
    for (let depth = 0; depth < 8; depth += 1) {
      const element = document.elementFromPoint(x, y);
      if (!isInspectable(element)) return null;
      if (isElementBelowTarget(element, currentTarget)) {
        return deepestElementAtPoint(element, x, y);
      }
      hidden.push({
        element,
        pointerEvents: element.style.pointerEvents
      });
      element.style.pointerEvents = "none";
    }
    return null;
  } finally {
    hidden.forEach((item) => {
      item.element.style.pointerEvents = item.pointerEvents;
    });
  }
}

function isElementBelowTarget(element, currentTarget) {
  if (!element || element === currentTarget) return false;
  if (element === STATE.selected) return false;
  if (STATE.selected && STATE.selected.contains(element)) return false;
  if (element === document.documentElement || element === document.body) return false;
  return true;
}

function selectElement(element) {
  if (!isInspectable(element)) return;
  STATE.selected = element;
  drawOverlay(element, true);
  updateDraggableCursor(element);
  resolveElementSource(element);
  warmStyleSourceMaps(element);
}

function clearSelectedElement() {
  STATE.selected = null;
  clearTimeout(STATE.selectedRefreshTimer);
  STATE.selectedRefreshTimer = 0;
  hideOverlay();
  updateDraggableCursor(STATE.hover);
  post("selected", null);
}

function releaseInspectorCaches() {
  STATE.styleModules.clear();
  STATE.sourceMapPositions.clear();
  STATE.sourceFiles.clear();
}

function findDeepestChildAtPoint(root, x, y) {
  if (!isInspectable(root)) return null;
  const candidates = Array.from(root.querySelectorAll("*"))
    .filter(isInspectable)
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
  return candidates.at(-1) || null;
}

function deepestElementAtPoint(root, x, y) {
  const child = findDeepestChildAtPoint(root, x, y);
  return child || root;
}

function deepestSelectableParent(element) {
  if (!isInspectable(element)) return null;
  if (STATE.selected && STATE.selected.contains(element) && STATE.selected !== element) return STATE.selected;
  return element.parentElement;
}

function updateDraggableCursor(element) {
  if (!isDragActive() || element !== STATE.selected) {
    document.documentElement.style.cursor = "";
    return;
  }
  const position = getComputedStyle(element).position;
  document.documentElement.style.cursor = isDraggablePosition(position) ? "move" : "";
}

function isDraggablePosition(position) {
  return position === "absolute" || position === "fixed";
}

function parseCssPixels(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function installTouchBridge() {
  let touching = false;
  document.addEventListener("mousedown", function(event) {
    if (isInspectorActive()) return;
    touching = true;
    dispatchSyntheticTouch("touchstart", event);
  }, true);
  document.addEventListener("mousemove", function(event) {
    if (!touching || isInspectorActive()) return;
    dispatchSyntheticTouch("touchmove", event);
  }, true);
  document.addEventListener("mouseup", function(event) {
    if (!touching || isInspectorActive()) return;
    dispatchSyntheticTouch("touchend", event);
    touching = false;
  }, true);
  document.addEventListener("mouseleave", function(event) {
    if (!touching || isInspectorActive()) return;
    dispatchSyntheticTouch("touchcancel", event);
    touching = false;
  }, true);
}

function dispatchSyntheticTouch(type, mouseEvent) {
  const target = mouseEvent.target;
  if (!(target instanceof EventTarget)) return;
  const touch = {
    identifier: 1,
    target,
    clientX: mouseEvent.clientX,
    clientY: mouseEvent.clientY,
    pageX: mouseEvent.pageX,
    pageY: mouseEvent.pageY,
    screenX: mouseEvent.screenX,
    screenY: mouseEvent.screenY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: mouseEvent.buttons ? 0.5 : 0
  };
  const touches = type === "touchend" || type === "touchcancel" ? [] : [touch];
  const event = createTouchEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    touches,
    targetTouches: touches,
    changedTouches: [touch],
    ctrlKey: mouseEvent.ctrlKey,
    shiftKey: mouseEvent.shiftKey,
    altKey: mouseEvent.altKey,
    metaKey: mouseEvent.metaKey
  });
  target.dispatchEvent(event);
}

function createTouchEvent(type, init) {
  try {
    return new TouchEvent(type, init);
  } catch (_) {
    const event = new Event(type, init);
    defineEventValue(event, "touches", init.touches);
    defineEventValue(event, "targetTouches", init.targetTouches);
    defineEventValue(event, "changedTouches", init.changedTouches);
    defineEventValue(event, "ctrlKey", init.ctrlKey);
    defineEventValue(event, "shiftKey", init.shiftKey);
    defineEventValue(event, "altKey", init.altKey);
    defineEventValue(event, "metaKey", init.metaKey);
    return event;
  }
}

function defineEventValue(event, key, value) {
  try {
    Object.defineProperty(event, key, {
      configurable: true,
      value
    });
  } catch (_) {}
}

function isInspectable(target) {
  return target instanceof Element && target !== STATE.overlay && target !== STATE.badge && target !== STATE.measureLayer;
}

function refreshOverlay() {
  if (!isInspectorActive()) {
    hideOverlay();
    refreshMeasurements();
    return;
  }
  if (STATE.selected) drawOverlay(STATE.selected, true);
  else if (STATE.hover) drawOverlay(STATE.hover, false);
  refreshMeasurements();
}

function isInspectorActive() {
  return STATE.enabled || Boolean(STATE.temporaryMode);
}

function isDragActive() {
  return STATE.dragEnabled || STATE.temporaryMode === "drag";
}

function drawOverlay(element, selected) {
  const rect = element.getBoundingClientRect();
  STATE.overlay.style.display = "block";
  STATE.overlay.style.left = rect.left + "px";
  STATE.overlay.style.top = rect.top + "px";
  STATE.overlay.style.width = rect.width + "px";
  STATE.overlay.style.height = rect.height + "px";
  STATE.overlay.style.borderColor = selected ? "#ffbf47" : "#2bd6a3";

  STATE.badge.style.display = "block";
  STATE.badge.textContent = badgeText(element, rect);
  placeBadge(rect);
  refreshMeasurements();
}

function placeBadge(targetRect) {
  const margin = 8;
  const width = STATE.badge.offsetWidth;
  const height = STATE.badge.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const candidates = [
    { left: margin, top: margin },
    { left: Math.max(margin, viewportWidth - width - margin), top: margin },
    { left: margin, top: Math.max(margin, viewportHeight - height - margin) },
    {
      left: Math.max(margin, viewportWidth - width - margin),
      top: Math.max(margin, viewportHeight - height - margin)
    }
  ];
  const expandedTarget = {
    left: targetRect.left - margin,
    top: targetRect.top - margin,
    right: targetRect.right + margin,
    bottom: targetRect.bottom + margin
  };
  const position =
    candidates.find((candidate) => {
      const badgeRect = {
        left: candidate.left,
        top: candidate.top,
        right: candidate.left + width,
        bottom: candidate.top + height
      };
      return !rectsOverlap(expandedTarget, badgeRect);
    }) || candidates[0];
  STATE.badge.style.left = position.left + "px";
  STATE.badge.style.top = position.top + "px";
}

function rectsOverlap(left, right) {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function refreshMeasurements() {
  if (!STATE.measuring || !STATE.selected) {
    hideMeasurements();
    return;
  }
  drawMeasurements(STATE.selected);
}

function drawMeasurements(element) {
  const parent = nearestPositionedParent(element);
  const elementRect = element.getBoundingClientRect();
  const parentRect = parent ? parent.getBoundingClientRect() : viewportRect();
  STATE.measureLayer.style.display = "block";
  STATE.measureLayer.replaceChildren();
  addMeasureBox(parentRect);
  addMeasureLine(
    elementRect.left,
    parentRect.top,
    elementRect.left,
    elementRect.top,
    Math.round(elementRect.top - parentRect.top) + "px",
    labelPosition(elementRect, "top")
  );
  addMeasureLine(
    parentRect.left,
    elementRect.top,
    elementRect.left,
    elementRect.top,
    Math.round(elementRect.left - parentRect.left) + "px",
    labelPosition(elementRect, "left")
  );
  addMeasureLine(
    elementRect.right,
    elementRect.top,
    parentRect.right,
    elementRect.top,
    Math.round(parentRect.right - elementRect.right) + "px",
    labelPosition(elementRect, "right")
  );
  addMeasureLine(
    elementRect.left,
    elementRect.bottom,
    elementRect.left,
    parentRect.bottom,
    Math.round(parentRect.bottom - elementRect.bottom) + "px",
    labelPosition(elementRect, "bottom")
  );
}

function hideMeasurements() {
  if (!STATE.measureLayer) return;
  STATE.measureLayer.style.display = "none";
  STATE.measureLayer.replaceChildren();
}

function nearestPositionedParent(element) {
  let current = element.parentElement;
  while (current && current !== document.documentElement) {
    if (getComputedStyle(current).position !== "static") return current;
    current = current.parentElement;
  }
  return null;
}

function viewportRect() {
  return {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight
  };
}

function addMeasureBox(rect) {
  const box = document.createElement("div");
  box.style.cssText = [
    "position:fixed",
    "left:" + rect.left + "px",
    "top:" + rect.top + "px",
    "width:" + rect.width + "px",
    "height:" + rect.height + "px",
    "border:1px dashed rgba(255,191,71,.78)",
    "background:rgba(255,191,71,.05)",
    "box-sizing:border-box"
  ].join(";");
  STATE.measureLayer.appendChild(box);
}

function labelPosition(rect, side) {
  const gap = 14;
  if (side === "top") {
    return { left: rect.left + rect.width / 2, top: rect.top - gap, transform: "translate(-50%, -100%)" };
  }
  if (side === "left") {
    return { left: rect.left - gap, top: rect.top + rect.height / 2, transform: "translate(-100%, -50%)" };
  }
  if (side === "right") {
    return { left: rect.right + gap, top: rect.top + rect.height / 2, transform: "translate(0, -50%)" };
  }
  return { left: rect.left + rect.width / 2, top: rect.bottom + gap, transform: "translate(-50%, 0)" };
}

function addMeasureLine(x1, y1, x2, y2, label, labelPos) {
  const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.max(1, Math.abs(x2 - x1));
  const height = Math.max(1, Math.abs(y2 - y1));
  const line = document.createElement("div");
  line.style.cssText = [
    "position:fixed",
    "left:" + left + "px",
    "top:" + top + "px",
    "width:" + (horizontal ? width : 1) + "px",
    "height:" + (horizontal ? 1 : height) + "px",
    "background:#ffbf47",
    "box-shadow:0 0 0 1px rgba(23,33,30,.18)"
  ].join(";");
  const tag = document.createElement("div");
  tag.textContent = label;
  tag.style.cssText = [
    "position:fixed",
    "left:" + clamp(labelPos.left, 8, window.innerWidth - 8) + "px",
    "top:" + clamp(labelPos.top, 8, window.innerHeight - 8) + "px",
    "transform:" + labelPos.transform,
    "padding:1px 5px",
    "border-radius:4px",
    "color:#101820",
    "background:#ffbf47",
    "font:11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace",
    "white-space:nowrap"
  ].join(";");
  STATE.measureLayer.appendChild(line);
  STATE.measureLayer.appendChild(tag);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hideOverlay() {
  STATE.overlay.style.display = "none";
  STATE.badge.style.display = "none";
  hideMeasurements();
}

function serializeElement(element) {
  const rect = element.getBoundingClientRect();
  const collected = safeMatchedStyleDeclarations(element);
  const { styles, styleSources } = collected;

  const attributes = {};
  for (const attribute of element.attributes) {
    attributes[attribute.name] = attribute.value;
  }

  return {
    tagName: element.tagName.toLowerCase(),
    selector: cssPath(element),
    pathSelector: fullCssPath(element),
    contextSelector: contextualSelector(element),
    text: (element.textContent || "").trim().slice(0, 120),
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    },
    attributes,
    sourceAttributes: readSourceAttributes(element),
    styles,
    styleSources,
    source: bestElementSource(element),
    elementSource: bestElementSource(element),
    url: location.href
  };
}

function safeMatchedStyleDeclarations(element) {
  try {
    return matchedStyleDeclarations(element);
  } catch (error) {
    post("status", { message: "CSS rule collection failed: " + (error?.message || error) });
    return fallbackComputedDeclarations(element);
  }
}

function fallbackComputedDeclarations(element, includeSourceStyles = true) {
  const computed = getComputedStyle(element);
  const styles = {};
  const styleSources = {};
  for (const property of fallbackStyleProperties()) {
    const value = computed.getPropertyValue(property);
    if (!value) continue;
    styles[property] = value;
  }

  if (includeSourceStyles) {
    const fallback = sourceStyleDeclarations(element, styleSources);
    Object.assign(styles, fallback.styles);
    Object.assign(styleSources, fallback.styleSources);
  }
  return { styles, styleSources };
}

function fallbackStyleProperties() {
  return [
    "display",
    "position",
    "left",
    "top",
    "right",
    "bottom",
    "width",
    "height",
    "margin",
    "padding",
    "color",
    "background-color",
    "background-image",
    "font-size",
    "font-weight",
    "font-family",
    "line-height",
    "text-align",
    "border-radius",
    "transform"
  ];
}

function readSourceAttributes(element) {
  const source = bestElementSource(element);
  if (!source.file || !source.line) return {};
  const template = readSourceTemplateLine(source.file, source.line);
  if (!template) return {};
  return {
    src: readAttributeFromLine(template, "src")
  };
}

function readSourceTemplateLine(file, line) {
  return (readSourceFile(file) || "").split(/\r?\n/)[line - 1] || "";
}

function readAttributeFromLine(line, attribute) {
  const match = line.match(new RegExp("(?:^|\\s)(?:" + attribute + "|:" + attribute + "|v-bind:" + attribute + ")\\s*=\\s*(['\"])(.*?)\\1"));
  return match?.[2] || "";
}

function bestStyleSource(styleSources) {
  return Object.values(styleSources).find((source) => source?.file) || null;
}

function bestElementSource(element) {
  const resolved = readResolvedSource(element);
  if (resolved.file) return resolved;
  const vueInspector = readVueInspectorSource(element);
  if (vueInspector.file) return vueInspector;
  const direct = readSource(element);
  if (direct.file) return direct;
  return {};
}

function readVueInspectorSource(element) {
  const trace = STATE.vueInspectorListeners?.findTraceFromElement?.(element);
  if (!trace?.pos) {
    loadVueInspectorListeners();
    return {};
  }
  return {
    file: trace.pos[0],
    line: Number(trace.pos[1]) || undefined,
    column: Number(trace.pos[2]) || undefined
  };
}

function loadVueInspectorListeners() {
  if (STATE.vueInspectorListenersLoaded) return;
  STATE.vueInspectorListenersLoaded = true;
  import(__WEB_NO_CODE_VUE_INSPECTOR_LISTENERS_ID__)
    .then((module) => {
      STATE.vueInspectorListeners = module;
      if (STATE.selected) resolveElementSource(STATE.selected);
    })
    .catch(() => {});
}

function resolveElementSource(element) {
  if (readResolvedSource(element).file) {
    if (STATE.selected === element) post("selected", serializeElement(element));
    return;
  }
  const requestId = (element.__webNoCodeSourceRequestId || 0) + 1;
  element.__webNoCodeSourceRequestId = requestId;
  fetch("/@web-no-code/source/element", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(serializeElementForSourceLookup(element))
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (element.__webNoCodeSourceRequestId !== requestId) return;
      if (payload?.source?.file) {
        element.__webNoCodeSource = payload.source;
      }
    })
    .catch(() => {})
    .finally(() => {
      if (element.__webNoCodeSourceRequestId !== requestId) return;
      if (STATE.selected === element) post("selected", serializeElement(element));
    });
}

function serializeElementForSourceLookup(element) {
  const computed = getComputedStyle(element);
  const source = bestElementSource(element);
  const attributes = {};
  for (const attribute of element.attributes) {
    attributes[attribute.name] = attribute.value;
  }
  return {
    tagName: element.tagName.toLowerCase(),
    selector: cssPath(element),
    contextSelector: contextualSelector(element),
    sourceFileHint: source.file || nearestSourceFile(element),
    sourceLineHint: source.line,
    sourceColumnHint: source.column,
    text: (element.textContent || "").trim().slice(0, 120),
    attributes,
    styles: {
      "background-image": computed.getPropertyValue("background-image")
    }
  };
}

function nearestSourceFile(element) {
  let current = element;
  while (current && current !== document.documentElement) {
    const source = readSource(current);
    if (source.file) return source.file;
    current = current.parentElement;
  }
  return "";
}

function findStyleSource(element, property) {
  const inlineValue = element.style.getPropertyValue(property);
  if (inlineValue) {
    return {
      file: readSource(element).file,
      selector: "style",
      value: inlineValue
    };
  }

  const matched = [];
  const counter = { order: 0 };
  for (const { sheet, rule } of matchedStyleRules(element)) {
    collectMatchedRule(element, property, sheet, rule, matched, counter);
  }

  matched.sort((left, right) => {
    if (left.important !== right.important) return left.important ? 1 : -1;
    const specificityDiff = compareSpecificity(left.specificity, right.specificity);
    if (specificityDiff) return specificityDiff;
    return left.order - right.order;
  });

  return bestMatchedSource(matched);
}

function bestMatchedSource(matched) {
  for (let index = matched.length - 1; index >= 0; index -= 1) {
    if (matched[index]?.source?.file) return matched[index].source;
  }
  return matched.at(-1)?.source || null;
}

function matchedStyleDeclarations(element) {
  const styles = {};
  const styleSources = {};
  const computed = getComputedStyle(element);

  const declarations = [];
  const counter = { order: 0 };
  const matchedRules = matchedStyleRules(element);

  for (const { sheet, rule } of matchedRules) {
    for (const property of declaredStyleProperties(rule.style)) {
      collectMatchedRule(element, property, sheet, rule, declarations, counter);
    }
  }

  for (const property of declaredStyleProperties(element.style)) {
    declarations.push({
      property,
      order: counter.order++,
      important: element.style.getPropertyPriority(property) === "important",
      specificity: [1, 0, 0],
      source: {
        file: readSource(element).file,
        selector: "style",
        value: element.style.getPropertyValue(property)
      }
    });
  }

  declarations.sort((left, right) => {
    if (left.important !== right.important) return left.important ? 1 : -1;
    const specificityDiff = compareSpecificity(left.specificity, right.specificity);
    if (specificityDiff) return specificityDiff;
    return left.order - right.order;
  });

  for (const declaration of declarations) {
    const property = declaration.property;
    const source = declaration.source;
    if (!property || !source) continue;
    const computedValue = computed.getPropertyValue(property);
    const sourceValue = source.value || "";
    if (shouldValidateComputedValue(property) && computedValue && sourceValue && !sameCssValue(property, computedValue, sourceValue)) continue;
    styles[property] = source.value || "";
    styleSources[property] = source;
  }

  const fallback = sourceStyleDeclarations(element, styleSources);
  for (const [property, value] of Object.entries(fallback.styles)) {
    if (styles[property]) continue;
    const computedValue = computed.getPropertyValue(property);
    if (shouldValidateComputedValue(property) && computedValue && value && !sameCssValue(property, computedValue, value)) continue;
    styles[property] = value;
    styleSources[property] = fallback.styleSources[property];
  }

  const runtime = fallbackComputedDeclarations(element, false);
  for (const [property, value] of Object.entries(runtime.styles)) {
    if (styles[property]) continue;
    styles[property] = value;
    styleSources[property] = {
      selector: "runtime",
      value
    };
  }
  return { styles, styleSources };
}

function sourceStyleDeclarations(element, existingSources) {
  const styles = {};
  const styleSources = {};
  const classNames = Array.from(element.classList || []);
  if (!classNames.length) return { styles, styleSources };

  const sourceFile = bestElementSource(element).file || "";
  const sources = sourceStyleSources(sourceFile, element);
  const declarations = sourceStyleDeclarationCandidates(sourceFile, classNames, sources, element);
  declarations.sort((left, right) => {
    if (left.filePriority !== right.filePriority) return left.filePriority - right.filePriority;
    if (left.block.ancestorScore !== right.block.ancestorScore) return left.block.ancestorScore - right.block.ancestorScore;
    if (left.block.primaryScore !== right.block.primaryScore) return left.block.primaryScore - right.block.primaryScore;
    if (left.block.score !== right.block.score) return left.block.score - right.block.score;
    return left.order - right.order;
  });

  for (const declaration of declarations) {
    styles[declaration.property] = declaration.value;
    styleSources[declaration.property] = {
      file: declaration.file,
      line: declaration.line,
      column: declaration.column,
      selector: declaration.block.selector,
      value: declaration.value
    };
  }
  return { styles, styleSources };
}

function sourceStyleDeclarationCandidates(elementSourceFile, classNames, sources, element = null) {
  const candidates = [];
  const ancestorClassNames = element ? elementAncestorClassNames(element) : [];
  for (const item of sources || sourceStyleSources(elementSourceFile, element)) {
    if (!item.file || !item.source) continue;
    const filePriority = sourceFilePriority(item.file, elementSourceFile);
    for (const block of sourceStyleBlocks(item.source, classNames, ancestorClassNames, element)) {
      for (const declaration of readSourceDeclarations(item.source, block.start, block.end)) {
        candidates.push({
          ...declaration,
          file: item.file,
          block,
          filePriority,
          order: block.start + declaration.offset
        });
      }
    }
  }
  return candidates;
}

function sourceStyleSources(elementSourceFile, element = null) {
  const sources = new Map();
  if (elementSourceFile) sources.set(elementSourceFile, readSourceFile(elementSourceFile));
  for (const sheet of Array.from(document.styleSheets)) {
    if (element) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue;
      }
      if (!sheetMatchesElement(element, Array.from(rules))) continue;
    }
    const file = fallbackStyleFile(sheet);
    if (!file) continue;
    const ownerText = styleOwner(sheet)?.textContent || "";
    sources.set(file, readSourceFile(file) || ownerText);
  }
  return Array.from(sources, ([file, source]) => ({ file, source }));
}

function sourceFilePriority(file, elementSourceFile) {
  if (file === elementSourceFile) return 3;
  if (elementSourceFile && dirnameOfPath(file) === dirnameOfPath(elementSourceFile)) return 2;
  return 1;
}

function dirnameOfPath(file) {
  return file.split("/").slice(0, -1).join("/");
}

function sourceStyleBlocks(source, classNames, ancestorClassNames = [], element = null) {
  const blocks = [];
  const classSet = new Set(classNames);
  const ancestorClassSet = new Set(ancestorClassNames);
  const primaryClass = classNames[0] || "";
  for (const className of classNames) {
    const token = "." + className;
    for (let tokenOffset = source.indexOf(token); tokenOffset >= 0; tokenOffset = source.indexOf(token, tokenOffset + token.length)) {
      if (!isSelectorClassToken(source, tokenOffset, token.length)) continue;
      const openOffset = source.indexOf("{", tokenOffset + token.length);
      if (openOffset < 0) continue;
      const selector = selectorBeforeBlock(source, openOffset);
      if (!selector) continue;
      if (element && !sourceSelectorMatchesElement(element, selector)) continue;
      const selectorClasses = classNamesFromSelector(selector);
      if (!selectorClasses.length || !selectorClasses.some((className) => classSet.has(className))) continue;
      const start = openOffset + 1;
      const end = matchingBraceOffset(source, openOffset);
      if (end < 0) continue;
      blocks.push({
        selector,
        start,
        end,
        score: selectorClasses.filter((className) => classSet.has(className)).length,
        ancestorScore: selectorClasses.filter((className) => ancestorClassSet.has(className)).length,
        primaryScore: primaryClass && selectorClasses.includes(primaryClass) ? 1 : 0,
        declarationCount: readSourceDeclarations(source, start, end).length
      });
    }
  }
  return dedupeSourceBlocks(blocks);
}

function isSelectorClassToken(source, offset, length) {
  const before = source[offset - 1] || "";
  const after = source[offset + length] || "";
  return !isClassNameChar(before) && !isClassNameChar(after);
}

function sourceSelectorMatchesElement(element, selectorText) {
  const selectors = selectorText.split(",").map((selector) => normalizeSourceSelectorForMatching(selector)).filter(Boolean);
  if (!selectors.length) return true;
  return selectors.some((selector) => {
    try {
      return element.matches(selector);
    } catch (_) {
      return true;
    }
  });
}

function normalizeSourceSelectorForMatching(selector) {
  return selector
    .replace(/::v-deep\s+/g, "")
    .replace(/:deep\(([^()]*)\)/g, "$1")
    .replace(/\[data-v-[^\]]+\]/g, "")
    .trim();
}

function elementAncestorClassNames(element) {
  const classNames = [];
  let current = element?.parentElement;
  while (current && current !== document.documentElement) {
    classNames.push(...Array.from(current.classList || []));
    current = current.parentElement;
  }
  return classNames;
}

function dedupeSourceBlocks(blocks) {
  const seen = new Set();
  return blocks.filter((block) => {
    const key = block.start + ":" + block.end + ":" + block.selector;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectorBeforeBlock(source, openOffset) {
  const declarationBoundary = Math.max(source.lastIndexOf("}", openOffset), source.lastIndexOf(";", openOffset));
  const nestedBoundary = source.lastIndexOf("{", openOffset);
  const declarationSelector = source.slice(declarationBoundary + 1, openOffset).trim();
  const nestedSelector = source.slice(nestedBoundary + 1, openOffset).trim();
  return normalizeSourceSelector(declarationSelector) || normalizeSourceSelector(nestedSelector);
}

function normalizeSourceSelector(selector) {
  if (!selector || selector.startsWith("@")) return "";
  if (!classNamesFromSelector(selector).length) return "";
  return selector;
}

function classNamesFromSelector(selector) {
  const classes = [];
  for (let index = 0; index < selector.length; index += 1) {
    if (selector[index] !== ".") continue;
    let end = index + 1;
    while (end < selector.length && isClassNameChar(selector[end])) end += 1;
    if (end > index + 1) classes.push(selector.slice(index + 1, end));
    index = end - 1;
  }
  return classes;
}

function isClassNameChar(char) {
  return /[A-Za-z0-9_-]/.test(char);
}

function matchingBraceOffset(source, openOffset) {
  let depth = 0;
  for (let index = openOffset; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function readSourceDeclarations(source, start, end) {
  const declarations = [];
  const block = source.slice(start, end);
  let declarationStart = 0;
  for (let index = 0; index <= block.length; index += 1) {
    if (index < block.length && block[index] !== ";") continue;
    const chunk = block.slice(declarationStart, index);
    const chunkStart = declarationStart;
    declarationStart = index + 1;
    if (nestedBlockDepth(block, chunkStart) > 0) continue;
    const separator = chunk.indexOf(":");
    if (separator < 0 || chunk.includes("{") || chunk.includes("}")) continue;
    const property = chunk.slice(0, separator).trim();
    if (!/^[A-Za-z-]+$/.test(property)) continue;
    const value = chunk.slice(separator + 1).trim().replace(/!important\s*$/, "").trim();
    if (!value) continue;
    const absoluteOffset = start + chunkStart + chunk.indexOf(property);
    const location = locationFromOffset(source, absoluteOffset, "");
    declarations.push({
      property,
      value,
      line: location?.line,
      column: location?.column,
      offset: chunkStart + chunk.indexOf(property)
    });
  }
  return declarations;
}

function nestedBlockDepth(text, offset) {
  let depth = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function matchedStyleRules(element) {
  const matched = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (_) {
      continue;
    }
    collectMatchedStyleRules(element, sheet, Array.from(rules), matched);
  }
  return matched;
}

function collectMatchedStyleRules(element, sheet, rules, matched) {
  rules.forEach((rule) => {
    if ("cssRules" in rule && rule.cssRules) {
      collectMatchedStyleRules(element, sheet, Array.from(rule.cssRules), matched);
      return;
    }
    if (!("selectorText" in rule) || !rule.style) return;
    if (!matchesSelector(element, rule.selectorText)) return;
    matched.push({ sheet, rule });
  });
}

function collectMatchedRule(element, property, sheet, rule, matched, counter) {
  const order = counter.order++;
  const matchedProperty = findDeclaredProperty(rule.style, property);
  if (!matchedProperty) return;

  const generated = locateGeneratedRule(sheet, rule, matchedProperty);
  const mapped = generated ? mapGeneratedLocation(sheet, generated.line, generated.column) : null;
  const scopedFile = scopedStyleFile(rule.selectorText);
  const sourceFile = mapped?.file || scopedFile || generated?.file || "";
  const ruleValue = rule.style.getPropertyValue(matchedProperty);
  const sourceDeclaration = readSourceDeclarationForRule(element, sourceFile, matchedProperty);
  const matchedSourceDeclaration =
    sourceDeclaration && sameCssValue(matchedProperty, sourceDeclaration.value, ruleValue) ? sourceDeclaration : null;
  const sourceValue = readSourceDeclarationValue(mapped || generated, matchedProperty);
  const source = matchedSourceDeclaration || (selectorReferencesElementClass(rule.selectorText, element) ? {
    file: sourceFile,
    line: mapped?.line || generated?.line,
    column: mapped?.column || generated?.column,
    selector: rule.selectorText,
    value: sourceValue || ruleValue
  } : null);
  matched.push({
    property,
    order,
    important: rule.style.getPropertyPriority(matchedProperty) === "important",
    specificity: selectorSpecificity(rule.selectorText),
    source
  });
}

function selectorReferencesElementClass(selectorText, element) {
  const classNames = Array.from(element.classList || []);
  if (!classNames.length) return false;
  const selectorClasses = classNamesFromSelector(selectorText);
  return selectorClasses.some((className) => classNames.includes(className));
}

function declaredStyleProperties(style) {
  const properties = [];
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index);
    if (property) properties.push(property);
  }
  return properties;
}

function sameCssValue(property, left, right) {
  const normalizedLeft = normalizeCssDeclarationValue(property, left);
  const normalizedRight = normalizeCssDeclarationValue(property, right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (property.startsWith("background") && normalizedLeft.includes(normalizedRight)) return true;
  if (property.startsWith("background") && normalizedRight.includes(normalizedLeft)) return true;
  return false;
}

function shouldValidateComputedValue(property) {
  return [
    "color",
    "background-color",
    "background-image",
    "font-size",
    "font-weight",
    "font-family",
    "line-height",
    "text-align",
    "display",
    "position",
    "transform",
    "opacity",
    "border-radius"
  ].includes(property);
}

function normalizeCssDeclarationValue(property, value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const probe = document.createElement("div");
  probe.style.setProperty(property, trimmed);
  const normalized = probe.style.getPropertyValue(property);
  return (normalized || trimmed).replace(/\s+/g, " ").trim();
}

function readSourceDeclarationValue(location, property) {
  if (!location?.file || !location.line) return "";
  const source = readSourceFile(location.file);
  if (!source) return "";
  const offset = offsetFromLocation(source, location.line, location.column || 1);
  const blockStart = source.lastIndexOf("{", offset);
  const blockEnd = source.indexOf("}", offset);
  if (blockStart < 0 || blockEnd < 0 || blockEnd <= blockStart) return "";
  const declarationBlock = source.slice(blockStart + 1, blockEnd);
  return readDeclarationValue(declarationBlock, property);
}

function readSourceDeclarationForRule(element, file, property) {
  if (!file) return null;
  const source = readSourceFile(file);
  if (!source) return null;
  const classNames = Array.from(element.classList || []);
  if (!classNames.length) return null;
  const declarations = sourceStyleDeclarationCandidates(file, classNames, [{ file, source }], element).filter(
    (declaration) => declaration.property === property
  );
  declarations.sort((left, right) => {
    if (left.block.ancestorScore !== right.block.ancestorScore) return left.block.ancestorScore - right.block.ancestorScore;
    if (left.block.primaryScore !== right.block.primaryScore) return left.block.primaryScore - right.block.primaryScore;
    if (left.block.score !== right.block.score) return left.block.score - right.block.score;
    return left.order - right.order;
  });
  const declaration = declarations.at(-1);
  if (!declaration) return null;
  return {
    file: declaration.file,
    line: declaration.line,
    column: declaration.column,
    selector: declaration.block.selector,
    value: declaration.value
  };
}

function readSourceFile(file) {
  if (!file) return "";
  if (STATE.sourceFiles.has(file)) return readCachedValue(STATE.sourceFiles, file) || "";

  const rawSource = requestSourceText("/@web-no-code/source/raw?file=" + encodeURIComponent(file));
  if (rawSource) {
    setBoundedCache(STATE.sourceFiles, file, rawSource, SOURCE_FILE_CACHE_LIMIT);
    return rawSource;
  }

  const rawModuleUrl = rawSourceModuleUrl(file);
  const source = rawModuleUrl ? unwrapViteRawSource(requestSourceText(rawModuleUrl)) : "";
  setBoundedCache(STATE.sourceFiles, file, source, SOURCE_FILE_CACHE_LIMIT);
  return source;
}

function readCachedValue(cache, key) {
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setBoundedCache(cache, key, value, limit) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    cache.delete(cache.keys().next().value);
  }
}

function requestSourceText(url) {
  if (!url) return "";
  try {
    const request = new XMLHttpRequest();
    request.open("GET", url, false);
    request.send(null);
    if (request.status < 200 || request.status >= 300) return "";
    return request.responseText || "";
  } catch (_) {
    return "";
  }
}

function rawSourceModuleUrl(file) {
  const url = styleModuleUrl(file);
  if (!url) return "";
  return url + (url.includes("?") ? "&" : "?") + "raw";
}

function unwrapViteRawSource(source) {
  if (!source) return "";
  const moduleText = source.trimStart();
  if (!moduleText.startsWith("export default")) return source;
  const literalStart = moduleText.indexOf("export default") + "export default".length;
  const literalEnd = moduleText.indexOf("\n//# sourceMappingURL=", literalStart);
  const literal = moduleText.slice(literalStart, literalEnd >= 0 ? literalEnd : undefined).trim().replace(/;$/, "");
  try {
    return Function('"use strict";return (' + literal + ")")();
  } catch (_) {
    return "";
  }
}

function offsetFromLocation(text, line, column) {
  let offset = 0;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < Math.max(0, line - 1); index += 1) {
    offset += (lines[index] || "").length + 1;
  }
  return Math.min(text.length, offset + Math.max(0, column - 1));
}

function readDeclarationValue(declarationBlock, property) {
  for (const candidate of propertyCandidates(property)) {
    const match = declarationBlock.match(new RegExp("(?:^|[;\\s])" + escapeRegExp(candidate) + "\\s*:\\s*([^;]+)"));
    if (match?.[1]) return match[1].trim().replace(/!important\s*$/, "").trim();
  }
  return "";
}

function escapeRegExp(value) {
  let escaped = "";
  const special = ".*+?^$(){}|[]\\";
  for (const char of value) {
    escaped += special.includes(char) ? "\\" + char : char;
  }
  return escaped;
}

function scopedStyleFile(selectorText) {
  const scopeId = vueScopeIdFromSelector(selectorText);
  if (!scopeId) return "";
  for (const element of Array.from(document.querySelectorAll("[" + scopeId + "]"))) {
    const source = bestElementSource(element);
    if (source.file) return source.file;
  }
  return "";
}

function vueScopeIdFromSelector(selectorText) {
  return selectorText.match(/\[(data-v-[\w-]+)\]/)?.[1] || "";
}

function findDeclaredProperty(style, property) {
  return propertyCandidates(property).find((candidate) => style.getPropertyValue(candidate));
}

function matchesSelector(element, selectorText) {
  return selectorText.split(",").some((selector) => {
    try {
      return element.matches(selector.trim());
    } catch (_) {
      return false;
    }
  });
}

function locateGeneratedRule(sheet, rule, property) {
  const owner = styleOwner(sheet);
  const cssText = owner?.textContent || "";
  if (!cssText) return fallbackStyleLocation(sheet);

  const index = findRuleOffset(cssText, rule);
  if (index < 0) return fallbackStyleLocation(sheet);

  const propertyOffset = findPropertyOffset(cssText, property, index);
  return locationFromOffset(cssText, propertyOffset >= 0 ? propertyOffset : index, fallbackStyleFile(sheet));
}

function findRuleOffset(cssText, rule) {
  const ruleText = rule.cssText || "";
  if (ruleText) {
    const exact = cssText.indexOf(ruleText);
    if (exact >= 0) return exact;
    const normalized = normalizeCssText(ruleText);
    const normalizedIndex = normalizeCssText(cssText).indexOf(normalized);
    if (normalizedIndex >= 0) {
      return denormalizedOffset(cssText, normalizedIndex);
    }
  }

  if (rule.selectorText) {
    const selectorIndex = cssText.indexOf(rule.selectorText);
    if (selectorIndex >= 0) return selectorIndex;
    for (const selector of rule.selectorText.split(",")) {
      const index = cssText.indexOf(selector.trim());
      if (index >= 0) return index;
    }
  }

  return -1;
}

function findPropertyOffset(cssText, property, ruleOffset) {
  const ruleEnd = cssText.indexOf("}", ruleOffset);
  const searchEnd = ruleEnd >= 0 ? ruleEnd : cssText.length;
  for (const candidate of propertyCandidates(property)) {
    const index = cssText.indexOf(candidate, ruleOffset);
    if (index >= 0 && index < searchEnd) return index;
  }
  return -1;
}

function propertyCandidates(property) {
  const candidates = [property];
  if (property.startsWith("background-")) candidates.push("background");
  if (property.startsWith("border-")) candidates.push("border");
  if (property.startsWith("margin-")) candidates.push("margin");
  if (property.startsWith("padding-")) candidates.push("padding");
  return Array.from(new Set(candidates));
}

function normalizeCssText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function denormalizedOffset(cssText, normalizedOffset) {
  let compactIndex = 0;
  let inWhitespace = false;
  for (let index = 0; index < cssText.length; index += 1) {
    const isWhitespace = /\s/.test(cssText[index]);
    if (isWhitespace) {
      if (inWhitespace) continue;
      inWhitespace = true;
    } else {
      inWhitespace = false;
    }
    if (compactIndex >= normalizedOffset) return index;
    compactIndex += 1;
  }
  return -1;
}

function fallbackStyleLocation(sheet) {
  const file = fallbackStyleFile(sheet);
  return file ? { file } : null;
}

function fallbackStyleFile(sheet) {
  const owner = styleOwner(sheet);
  const viteId = owner?.getAttribute?.("data-vite-dev-id");
  if (viteId) return normalizeViteFile(viteId);
  if (sheet.href) return normalizeViteFile(sheet.href);
  return "";
}

function locationFromOffset(text, offset, file) {
  if (offset < 0) return file ? { file } : null;
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return {
    file,
    line: lines.length,
    column: lines.at(-1).length + 1
  };
}

function mapGeneratedLocation(sheet, line, column) {
  const sourceMap = readSourceMap(sheet);
  if (sourceMap && line && column) {
    const original = originalPositionForSource(sourceMap, line, column - 1, isEditableStyleSource);
    if (original?.source) {
      return {
        file: normalizeViteFile(original.source),
        line: original.line,
        column: original.column == null ? undefined : original.column + 1
      };
    }
  }

  return resolveServerSourceMapPosition(sheet, line, column);
}

function readSourceMap(sheet) {
  const inline = readInlineSourceMap(sheet);
  if (inline) return inline;

  const module = readStyleModule(sheet);
  if (module?.map) return module.map;

  loadStyleModule(sheet);
  return null;
}

function readInlineSourceMap(sheet) {
  const owner = styleOwner(sheet);
  const cssText = owner?.textContent || "";
  return readInlineSourceMapFromCss(cssText);
}

function readInlineSourceMapFromCss(cssText) {
  const match = cssText.match(/sourceMappingURL=data:application\/json[^,]*,([^\s*]+)/);
  if (!match) return null;
  try {
    return compactSourceMap(JSON.parse(decodeURIComponent(match[1])));
  } catch (_) {
    try {
      return compactSourceMap(JSON.parse(atob(match[1])));
    } catch (_) {
      return null;
    }
  }
}

function compactSourceMap(map) {
  if (!map || typeof map !== "object") return null;
  delete map.sourcesContent;
  return map;
}

function readStyleModule(sheet) {
  const key = styleModuleKey(sheet);
  return key && STATE.styleModules.has(key) ? readCachedValue(STATE.styleModules, key) : null;
}

function loadStyleModule(sheet) {
  const key = styleModuleKey(sheet);
  if (!key || !isSafeStyleModuleId(key)) return;
  const cached = STATE.styleModules.get(key);
  if (cached) return;

  const url = styleModuleUrl(key);
  if (!url) return;
  const pending = fetch(url)
    .then((response) => (response.ok ? response.text() : ""))
    .then((source) => {
      const css = extractViteCss(source);
      const map = css ? readInlineSourceMapFromCss(css) : null;
      setBoundedCache(STATE.styleModules, key, { map }, STYLE_MODULE_CACHE_LIMIT);
      scheduleSelectedRefresh();
    })
    .catch(() => {
      setBoundedCache(STATE.styleModules, key, { map: null }, STYLE_MODULE_CACHE_LIMIT);
    });
  setBoundedCache(STATE.styleModules, key, { pending }, STYLE_MODULE_CACHE_LIMIT);
}

function resolveServerSourceMapPosition(sheet, line, column) {
  const id = styleModuleKey(sheet) || sheet.href || "";
  if (!id || !line || !column || !isSafeStyleModuleId(id)) return null;
  const key = id + ":" + line + ":" + column;
  if (STATE.sourceMapPositions.has(key)) return readCachedValue(STATE.sourceMapPositions, key);

  const pending = fetch(
    "/@web-no-code/source-map/original-position?id=" +
      encodeURIComponent(id) +
      "&line=" +
      encodeURIComponent(String(line)) +
      "&column=" +
      encodeURIComponent(String(column))
  )
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      const position = payload?.position;
      const normalized = position?.file
        ? {
            file: normalizeViteFile(position.file),
            line: position.line,
            column: position.column
          }
        : null;
      setBoundedCache(STATE.sourceMapPositions, key, normalized, SOURCE_MAP_POSITION_CACHE_LIMIT);
      scheduleSelectedRefresh();
    })
    .catch(() => {
      setBoundedCache(STATE.sourceMapPositions, key, null, SOURCE_MAP_POSITION_CACHE_LIMIT);
    });

  setBoundedCache(STATE.sourceMapPositions, key, null, SOURCE_MAP_POSITION_CACHE_LIMIT);
  return null;
}

function scheduleSelectedRefresh() {
  clearTimeout(STATE.selectedRefreshTimer);
  STATE.selectedRefreshTimer = window.setTimeout(() => {
    STATE.selectedRefreshTimer = 0;
    if (STATE.selected) post("selected", serializeElement(STATE.selected));
  }, 50);
}

function warmStyleSourceMaps(element) {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (_) {
      continue;
    }
    if (sheetMatchesElement(element, Array.from(rules))) loadStyleModule(sheet);
  }
}

function sheetMatchesElement(element, rules) {
  for (const rule of rules) {
    if ("cssRules" in rule && rule.cssRules && sheetMatchesElement(element, Array.from(rule.cssRules))) return true;
    if (!("selectorText" in rule) || !rule.style) continue;
    if (matchesSelector(element, rule.selectorText)) return true;
  }
  return false;
}

function styleModuleKey(sheet) {
  const owner = styleOwner(sheet);
  return owner?.getAttribute?.("data-vite-dev-id") || "";
}

function styleOwner(sheet) {
  if (sheet.ownerNode) return sheet.ownerNode;
  for (const node of document.querySelectorAll("style,link")) {
    if (node.sheet === sheet) return node;
  }
  return null;
}

function styleModuleUrl(id) {
  if (!isSafeStyleModuleId(id)) return "";
  if (id.startsWith(location.origin)) return new URL(id).pathname + new URL(id).search;
  if (id.startsWith("/@fs/") || id.startsWith("/@id/") || id.startsWith("/src/")) return id;
  if (id.startsWith("/")) return "/@fs" + id;
  if (id.startsWith("src/")) return "/" + id;
  if (id.startsWith("./") || id.startsWith("../")) return id;
  return id;
}

function isSafeStyleModuleId(id) {
  if (!id || id.startsWith("~") || id.startsWith("\0")) return false;
  if (id.includes("://")) return id.startsWith(location.origin);
  if (id.startsWith("/@fs/") || id.startsWith("/@id/") || id.startsWith("/src/")) return true;
  if (id.startsWith("/") || id.startsWith("src/") || id.startsWith("./") || id.startsWith("../")) return true;
  return false;
}

function extractViteCss(source) {
  const match = source.match(/const\s+__vite__css\s*=\s*("(?:(?:\\.|[^"\\])*)"|'(?:(?:\\.|[^'\\])*)')/);
  if (!match) return "";
  try {
    return Function('"use strict";return (' + match[1] + ")")();
  } catch (_) {
    return "";
  }
}

function normalizeViteFile(value) {
  try {
    const url = new URL(value, location.href);
    return normalizeSourcePath(url.pathname);
  } catch (_) {
    return normalizeSourcePath(value);
  }
}

function normalizeSourcePath(value) {
  const decoded = decodeURIComponent(value);
  if (decoded.startsWith("/@fs/")) return decoded.slice("/@fs".length);
  if (/^\/[A-Za-z]:\//.test(decoded)) return decoded.slice(1);
  if (decoded.startsWith("/Users/") || decoded.startsWith("/Volumes/") || decoded.startsWith("/private/")) return decoded;
  if (decoded.startsWith("/src/")) return decoded.slice(1);
  return decoded.replace(/^\//, "");
}

function selectorSpecificity(selectorText) {
  const selectors = selectorText.split(",");
  return selectors.reduce((best, selector) => {
    const clean = selector.replace(/:where\([^)]*\)/g, "");
    const ids = (clean.match(/#[\w-]+/g) || []).length;
    const classes = (clean.match(/(\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?)/g) || []).length;
    const elements = (clean.match(/(^|[\s>+~])[\w-]+/g) || []).length;
    const next = [ids, classes, elements];
    return compareSpecificity(next, best) > 0 ? next : best;
  }, [0, 0, 0]);
}

function compareSpecificity(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function originalPositionFor(map, generatedLine, generatedColumn) {
  return originalPositionForSource(map, generatedLine, generatedColumn, () => true);
}

function originalPositionForSource(map, generatedLine, generatedColumn, acceptSource) {
  if (!map.mappings) return null;
  const lines = map.mappings.split(";");
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  let best = null;
  let nearest = null;
  let nearestDistance = Infinity;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (lineIndex + 1 > generatedLine) break;
    let generatedColumnCursor = 0;
    const segments = line ? line.split(",") : [];
    for (const segment of segments) {
      if (!segment) continue;
      const values = decodeVlqSegment(segment);
      generatedColumnCursor += values[0];
      if (values.length >= 4) {
        sourceIndex += values[1];
        originalLine += values[2];
        originalColumn += values[3];
        if (values.length >= 5) nameIndex += values[4];
      }
      if (lineIndex + 1 === generatedLine && values.length >= 4) {
        const source = map.sources?.[sourceIndex];
        if (!source || !acceptSource(source)) continue;
        const position = {
          source: map.sources?.[sourceIndex],
          line: originalLine + 1,
          column: originalColumn,
          name: map.names?.[nameIndex]
        };
        if (generatedColumnCursor <= generatedColumn) {
          best = position;
        }
        const distance = Math.abs(generatedColumnCursor - generatedColumn);
        if (distance < nearestDistance) {
          nearest = position;
          nearestDistance = distance;
        }
      }
    }
  }

  return best || nearest;
}

function isEditableStyleSource(source) {
  const path = source.split(/[?#]/)[0].toLowerCase();
  return /\.(vue|css|scss|sass|less|styl|stylus|pcss|postcss)$/.test(path);
}

function decodeVlqSegment(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = base64VlqValue(char);
    const continuation = digit & 32;
    value += (digit & 31) << shift;
    if (continuation) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    values.push((value >> 1) * (negative ? -1 : 1));
    value = 0;
    shift = 0;
  }
  return values;
}

function base64VlqValue(char) {
  const code = char.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (char === "+") return 62;
  if (char === "/") return 63;
  return 0;
}

function readSource(element) {
  const direct = element.getAttribute("data-source") || element.getAttribute("data-v-inspector");
  if (direct) {
    const match = direct.match(/(.+):(\d+):(\d+)/);
    if (match) {
      return {
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3])
      };
    }
    return { file: direct };
  }
  return {};
}

function readResolvedSource(element) {
  return element.__webNoCodeSource || {};
}

function cssPath(element) {
  if (element.id) return "#" + CSS.escape(element.id);
  return fullCssPath(element);
}

function fullCssPath(element) {
  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    let part = current.id ? "#" + CSS.escape(current.id) : current.nodeName.toLowerCase();
    if (!current.id && current.classList.length) {
      part += "." + Array.from(current.classList).slice(0, 3).map((item) => CSS.escape(item)).join(".");
    }
    const parent = current.parentElement;
    if (parent && !current.id) {
      const siblings = Array.from(parent.children).filter((item) => item.nodeName === current.nodeName);
      if (siblings.length > 1) {
        part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      }
    }
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function contextualSelector(element) {
  const leaf = compactElementSelector(element);
  if (!leaf) return "";
  const parent = nearestClassParent(element);
  if (!parent) return leaf;
  const parentSelector = compactElementSelector(parent);
  return parentSelector ? parentSelector + " " + leaf : leaf;
}

function nearestClassParent(element) {
  let current = element.parentElement;
  while (current && current !== document.documentElement) {
    if (current.classList.length) return current;
    current = current.parentElement;
  }
  return null;
}

function compactElementSelector(element) {
  if (element.id) return "#" + CSS.escape(element.id);
  if (element.classList.length) {
    return "." + Array.from(element.classList).map((item) => CSS.escape(item)).join(".");
  }
  return element.tagName ? element.tagName.toLowerCase() : "";
}

function badgeText(element, rect) {
  const className = element.classList.length ? "." + Array.from(element.classList).join(".") : "";
  return element.tagName.toLowerCase() + className + " " + Math.round(rect.width) + "x" + Math.round(rect.height);
}

function post(type, payload) {
  window.parent?.postMessage(
    {
      source: "web-no-code-inspector",
      type,
      payload
    },
    "*"
  );
}

init();
`;
