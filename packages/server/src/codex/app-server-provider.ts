import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCommand, runCommand } from "./utils";
import {
  createShadowWorkspace,
  diffShadowWorkspace,
  disposeAllShadowWorkspaces,
  type ShadowWorkspace
} from "../workspace/shadow-workspace";
import type {
  CodexModel,
  CodexEvent,
  CodexProvider,
  SelectedElementContext,
  CodexTurnStatus,
  EventSink,
  ProviderStatus,
  ResumeThreadOptions,
  RunTurnOptions,
  SandboxMode,
  StartThreadOptions,
  SteerTurnResult,
  ThreadHandle,
  TurnResult,
  WorkspaceMode
} from "./types";

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type AppThread = {
  threadId: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  workspaceMode: WorkspaceMode;
  sandbox: SandboxMode;
  shadow: ShadowWorkspace | null;
  codexRoot: string;
  finalMessage: string;
  diff: string;
  activeTurnId?: string;
  changedFiles: string[];
  lastTurnDurationMs?: number;
};

const WEB_NO_CODE_INSTRUCTIONS = [
  "<WEB_NO_CODE_CONTEXT>",
  "You are editing a local Vite project through Web No Code.",
  "Make only the source changes needed for the user's request, scoped to selected elements when context is provided.",
  "Return a concise summary and rely on file changes for the diff. The UI will require user confirmation before applying visible edits.",
  "</WEB_NO_CODE_CONTEXT>"
].join("\n");

type PendingTurn = {
  threadId: string;
  turnId?: string;
  startedAt: number;
  textDeltas: string[];
  completedMessages: string[];
  completedTurn: Record<string, unknown> | null;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class AppServerProvider implements CodexProvider {
  readonly name = "app-server" as const;

  private static readonly schemaGenerationTimeoutMs = 30000;

  private process: ChildProcessWithoutNullStreams | null = null;
  private reader: readline.Interface | null = null;
  private nextId = 1;
  private initialized = false;
  private startPromise: Promise<void> | null = null;
  private statusPromise: Promise<ProviderStatus> | null = null;
  private detectedStatus: ProviderStatus | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly threads = new Map<string, AppThread>();
  private readonly sink: EventSink;
  private startupError: string | null = null;
  private codexBin: string | null = null;

  constructor(sink: EventSink) {
    this.sink = sink;
  }

  async status(): Promise<ProviderStatus> {
    let status = this.detectedStatus;
    if (!status) {
      if (!this.statusPromise) {
        this.statusPromise = this.detectStatus()
          .then((status) => {
            // Do not make a transient CLI or filesystem failure permanent for
            // the lifetime of the editor server. Successful detection can be
            // reused; failed detection should be retried by the next request.
            if (status.available) this.detectedStatus = status;
            return status;
          })
          .catch((error) => ({
            provider: this.name,
            mode: "app-server" as const,
            available: false,
            reason: error instanceof Error ? error.message : String(error)
          }))
          .finally(() => {
            this.statusPromise = null;
          });
      }
      status = await this.statusPromise;
    }

    return status.available
      ? { ...status, reason: this.initialized ? "codex app-server is running" : "codex CLI is available" }
      : status;
  }

  private async detectStatus(): Promise<ProviderStatus> {
    const codexBin = await resolveCommand("codex");
    if (!codexBin) {
      return {
        provider: this.name,
        mode: "app-server",
        available: false,
        reason: "codex command is not available on PATH"
      };
    }
    this.codexBin = codexBin;

    const version = await runCommand(codexBin, ["--version"], { timeoutMs: 3000 });
    if (version.code !== 0) {
      return {
        provider: this.name,
        mode: "app-server",
        available: false,
        reason: version.stderr || "codex --version failed"
      };
    }

    const schemaDir = await mkdtemp(join(tmpdir(), "web-no-code-codex-schema-"));
    try {
      const schema = await runCommand(
        codexBin,
        ["app-server", "generate-ts", "--out", schemaDir, "--experimental"],
        { timeoutMs: AppServerProvider.schemaGenerationTimeoutMs }
      );
      if (schema.code !== 0) {
        return {
          provider: this.name,
          mode: "app-server",
          available: false,
          codexVersion: version.stdout.trim(),
          reason: schema.timedOut
            ? `codex app-server generate-ts timed out after ${AppServerProvider.schemaGenerationTimeoutMs}ms`
            : schema.stderr || "codex app-server generate-ts failed"
        };
      }
    } finally {
      await rm(schemaDir, { recursive: true, force: true });
    }

    return {
      provider: this.name,
      mode: "app-server",
      available: true,
      codexVersion: version.stdout.trim(),
      reason: "codex CLI is available"
    };
  }

  async warmup(): Promise<ProviderStatus> {
    const status = await this.status();
    if (!status.available) return status;

    try {
      await this.ensureStarted();
      return {
        ...status,
        reason: "codex app-server is running"
      };
    } catch (error) {
      return {
        provider: this.name,
        mode: "app-server",
        available: false,
        codexVersion: status.codexVersion,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listModels(): Promise<CodexModel[]> {
    await this.ensureStarted();
    const models: CodexModel[] = [];
    let cursor: string | null = null;

    do {
      const result = (await this.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false
      })) as {
        data?: unknown;
        nextCursor?: unknown;
      };
      models.push(...normalizeModels(result.data));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    } while (cursor && models.length < 200);

    return models;
  }

  async startThread(options: StartThreadOptions): Promise<ThreadHandle> {
    await this.ensureStarted();
    const workspaceMode = resolveWorkspaceMode(options.workspaceMode);
    const shadow = workspaceMode === "shadow" ? await createShadowWorkspace(options.cwd) : null;
    const codexRoot = shadow?.shadowRoot || options.cwd;
    const result = (await this.request("thread/start", {
      cwd: codexRoot,
      model: options.model || null,
      config: modelConfig(options),
      approvalPolicy: "never",
      sandbox: toCodexSandbox(options.sandbox || "workspace-write"),
      serviceName: "Web No Code",
      developerInstructions: WEB_NO_CODE_INSTRUCTIONS,
      ephemeral: false
    })) as {
      thread?: {
        id?: string;
      };
    };

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("codex app-server did not return a thread id");
    }

    this.threads.set(threadId, {
      threadId,
      cwd: options.cwd,
      model: options.model || undefined,
      reasoningEffort: options.reasoningEffort || undefined,
      workspaceMode,
      sandbox: options.sandbox || "workspace-write",
      shadow,
      codexRoot,
      diff: "",
      finalMessage: "",
      changedFiles: []
    });
    this.sink.emit({
      type: "provider",
      provider: this.name,
      message: `Using local codex app-server for ${options.cwd}`
    });
    return { threadId, provider: this.name };
  }

  async resumeThread(options: ResumeThreadOptions): Promise<ThreadHandle> {
    await this.ensureStarted();
    const existing = this.threads.get(options.threadId);
    const requestedModel = options.model || undefined;
    const requestedReasoningEffort = options.reasoningEffort || undefined;
    const requestedSandbox = options.sandbox || "workspace-write";
    if (
      existing &&
      existing.cwd === options.cwd &&
      existing.model === requestedModel &&
      existing.reasoningEffort === requestedReasoningEffort &&
      existing.sandbox === requestedSandbox
    ) {
      return { threadId: existing.threadId, provider: this.name };
    }
    const workspaceMode = existing?.workspaceMode || resolveWorkspaceMode(options.workspaceMode);
    const shadow = existing?.shadow ?? (workspaceMode === "shadow" ? await createShadowWorkspace(options.cwd) : null);
    const codexRoot = shadow?.shadowRoot || options.cwd;
    const result = (await this.request("thread/resume", {
      threadId: options.threadId,
      cwd: codexRoot,
      model: options.model || null,
      config: modelConfig(options),
      approvalPolicy: "never",
      sandbox: toCodexSandbox(options.sandbox || "workspace-write"),
      developerInstructions: WEB_NO_CODE_INSTRUCTIONS,
      excludeTurns: true
    })) as {
      thread?: {
        id?: string;
      };
    };

    const threadId = result.thread?.id || options.threadId;
    if (existing && threadId !== options.threadId) {
      this.threads.delete(options.threadId);
    }

    this.threads.set(threadId, {
      threadId,
      cwd: options.cwd,
      model: requestedModel,
      reasoningEffort: requestedReasoningEffort,
      workspaceMode,
      sandbox: requestedSandbox,
      shadow,
      codexRoot,
      diff: existing?.diff || "",
      finalMessage: existing?.finalMessage || "",
      activeTurnId: existing?.activeTurnId,
      changedFiles: existing?.changedFiles || [],
      lastTurnDurationMs: existing?.lastTurnDurationMs
    });
    this.sink.emit({
      type: "provider",
      provider: this.name,
      message: `Resumed local codex app-server thread ${threadId}`
    });
    return { threadId, provider: this.name };
  }

  async runTurn(options: RunTurnOptions): Promise<TurnResult> {
    await this.ensureStarted();
    const thread = this.threads.get(options.threadId);
    if (!thread) {
      throw new Error(`Unknown app-server thread: ${options.threadId}`);
    }
    if (this.pendingTurns.has(options.threadId)) {
      throw new Error(`Thread ${options.threadId} already has an active Codex turn`);
    }

    thread.finalMessage = "";
    thread.diff = "";
    thread.changedFiles = [];
    thread.lastTurnDurationMs = undefined;

    const pendingResult = new Promise<TurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTurns.delete(options.threadId);
        thread.activeTurnId = undefined;
        reject(new Error("Codex turn timed out"));
      }, 15 * 60 * 1000);

      this.pendingTurns.set(options.threadId, {
        threadId: options.threadId,
        startedAt: Date.now(),
        textDeltas: [],
        completedMessages: [],
        completedTurn: null,
        resolve,
        reject,
        timer
      });
    });

    try {
      const response = (await this.request("turn/start", {
        threadId: options.threadId,
        cwd: thread.codexRoot,
        sandboxPolicy: toCodexSandboxPolicy(
          thread.codexRoot,
          thread.workspaceMode,
          thread.sandbox
        ),
        approvalPolicy: "never",
        input: buildTurnInput(options)
      })) as {
        turn?: {
          id?: string;
        };
      };

      const pending = this.pendingTurns.get(options.threadId);
      const turnId = response.turn?.id;
      thread.activeTurnId = turnId;
      if (pending) {
        pending.turnId = turnId;
      }
      this.sink.emit({
        type: "status",
        threadId: options.threadId,
        message: "Codex turn started"
      });
      this.maybeResolveTurn(options.threadId);
      return await pendingResult;
    } catch (error) {
      const pending = this.pendingTurns.get(options.threadId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingTurns.delete(options.threadId);
      }
      thread.activeTurnId = undefined;
      throw error;
    }
  }

  async steerTurn(options: RunTurnOptions): Promise<SteerTurnResult> {
    await this.ensureStarted();
    const thread = this.threads.get(options.threadId);
    if (!thread) {
      throw new Error(`Unknown app-server thread: ${options.threadId}`);
    }

    let pending = this.pendingTurns.get(options.threadId);
    let expectedTurnId = pending?.turnId || thread.activeTurnId;
    if (pending && !expectedTurnId) {
      expectedTurnId = await this.waitForActiveTurnId(options.threadId, pending);
      pending = this.pendingTurns.get(options.threadId);
    }
    if (!pending || !expectedTurnId) {
      return { threadId: options.threadId, turnId: expectedTurnId, steered: false };
    }

    try {
      const response = (await this.request("turn/steer", {
        threadId: options.threadId,
        expectedTurnId,
        input: buildTurnInput(options)
      })) as { turnId?: string };
      this.sink.emit({
        type: "status",
        threadId: options.threadId,
        message: "Steered current Codex turn"
      });
      return {
        threadId: options.threadId,
        turnId: response.turnId || expectedTurnId,
        steered: true
      };
    } catch (error) {
      const current = this.pendingTurns.get(options.threadId);
      if (!current || (current.turnId && current.turnId !== expectedTurnId)) {
        return { threadId: options.threadId, turnId: current?.turnId, steered: false };
      }
      throw error;
    }
  }

  async interrupt(threadId: string): Promise<void> {
    await this.ensureStarted();
    const thread = this.threads.get(threadId);
    if (!thread?.activeTurnId) {
      const pending = this.pendingTurns.get(threadId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingTurns.delete(threadId);
        pending.resolve({
          threadId,
          provider: this.name,
          finalMessage: "",
          diff: "",
          turnId: pending.turnId,
          durationMs: Date.now() - pending.startedAt,
          changedFiles: []
        });
      }
      if (thread) thread.activeTurnId = undefined;
      return;
    }
    const pending = this.pendingTurns.get(threadId);
    await this.request("turn/interrupt", { threadId, turnId: thread.activeTurnId });
    if (pending) {
      await this.waitForInterruptedTurn(threadId, pending);
    } else {
      thread.activeTurnId = undefined;
    }
  }

  getTurnStatus(threadId: string): CodexTurnStatus {
    const thread = this.threads.get(threadId);
    const pending = this.pendingTurns.get(threadId);
    return {
      threadId,
      active: Boolean(pending),
      turnId: pending?.turnId || thread?.activeTurnId,
      startedAt: pending?.startedAt,
      finalMessage: thread?.finalMessage || undefined,
      durationMs: thread?.lastTurnDurationMs
    };
  }

  async getDiff(threadId: string): Promise<string> {
    const thread = this.threads.get(threadId);
    if (!thread) return "";
    if (!thread.shadow) return thread.diff;
    const workspaceDiff = await diffShadowWorkspace(thread.shadow);
    thread.diff = workspaceDiff.diff || thread.diff;
    thread.changedFiles = workspaceDiff.changedFiles;
    return thread.diff;
  }

  getShadow(threadId: string) {
    return this.threads.get(threadId)?.shadow || null;
  }

  getChangedFiles(threadId: string) {
    return this.threads.get(threadId)?.changedFiles || [];
  }

  private async waitForActiveTurnId(threadId: string, pending: PendingTurn) {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const current = this.pendingTurns.get(threadId);
      if (current !== pending) return current?.turnId;
      const turnId = current.turnId || this.threads.get(threadId)?.activeTurnId;
      if (turnId) return turnId;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.pendingTurns.get(threadId)?.turnId || this.threads.get(threadId)?.activeTurnId;
  }

  async dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("codex app-server disposed"));
    }
    this.pending.clear();
    for (const pending of this.pendingTurns.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("codex app-server disposed"));
    }
    this.pendingTurns.clear();
    this.reader?.close();
    this.process?.kill("SIGTERM");
    await disposeAllShadowWorkspaces();
    this.process = null;
    this.reader = null;
    this.initialized = false;
  }

  private ensureStarted() {
    if (this.initialized) return Promise.resolve();
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async start() {
    if (this.initialized) return;

    const codexBin = this.codexBin || (await resolveCommand("codex"));
    if (!codexBin) {
      throw new Error("codex command is not available on PATH");
    }
    this.codexBin = codexBin;
    this.startupError = null;

    this.process = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.trim()) {
        this.sink.emit({ type: "status", message: text.trim() });
      }
    });

    this.process.on("error", (error) => {
      this.startupError = error.message;
      this.rejectAll(error);
    });

    this.process.on("exit", (code, signal) => {
      const reason = `codex app-server exited: ${code ?? signal ?? "unknown"}`;
      this.process = null;
      this.reader = null;
      this.initialized = false;
      this.rejectAll(new Error(reason));
    });

    this.reader = readline.createInterface({ input: this.process.stdout });
    this.reader.on("line", (line) => this.handleLine(line));

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "web-no-code",
          title: "Web No Code",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      },
      10000
    );
    this.notify("initialized", {});
    this.initialized = true;
  }

  private request(method: string, params: unknown, timeoutMs = 120000) {
    if (!this.process) {
      return Promise.reject(new Error("codex app-server is not running"));
    }

    const id = this.nextId++;
    const message = { method, id, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.process?.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private notify(method: string, params: unknown) {
    this.process?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string) {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.sink.emit({ type: "status", message: line });
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || `Codex error ${message.error.code}`));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params as Record<string, unknown> | undefined);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown> | undefined) {
    if (method === "item/agentMessage/delta") {
      const text = extractText(params);
      const threadId = extractThreadId(params);
      if (text) {
        const thread = threadId ? this.threads.get(threadId) : undefined;
        if (thread) thread.finalMessage += text;
        const pending = threadId ? this.pendingTurns.get(threadId) : undefined;
        if (pending) pending.textDeltas.push(text);
        this.sink.emit({ type: "delta", threadId, text });
      }
      return;
    }

    if (method === "item/completed") {
      const threadId = extractThreadId(params);
      const pending = threadId ? this.pendingTurns.get(threadId) : undefined;
      if (threadId && pending && isAgentMessageItem(params?.item)) {
        const text = extractText(params);
        if (text.trim()) {
          pending.completedMessages.push(text);
          const thread = this.threads.get(threadId);
          if (thread) thread.finalMessage = text;
        }
      }
      return;
    }

    if (method === "turn/diff/updated") {
      const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
      const diff = typeof params?.diff === "string" ? params.diff : "";
      if (threadId) {
        const thread = this.threads.get(threadId);
        if (thread) {
          thread.diff = diff;
          thread.changedFiles = changedFilesFromDiff(diff);
        }
      }
      this.sink.emit({ type: "diff", threadId, diff });
      return;
    }

    if (method === "turn/completed") {
      const threadId = extractThreadId(params);
      const thread = threadId ? this.threads.get(threadId) : undefined;
      const pending = threadId ? this.pendingTurns.get(threadId) : undefined;
      if (pending) {
        pending.completedTurn = asRecord(params?.turn);
        this.maybeResolveTurn(threadId!);
        return;
      }
      this.sink.emit({
        type: "completed",
        threadId,
        finalMessage: thread?.finalMessage || "",
        diff: thread?.diff || "",
        turnId: extractTurnId(params)
      });
      return;
    }

    if (method === "error") {
      this.sink.emit({
        type: "error",
        threadId: extractThreadId(params),
        message: JSON.stringify(params)
      });
      return;
    }

    if (method.endsWith("/started") || method.endsWith("/completed") || method.includes("status")) {
      this.sink.emit({
        type: "status",
        threadId: extractThreadId(params),
        message: method
      });
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.pendingTurns.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingTurns.clear();
  }

  private async completeTurn(threadId: string, pending: PendingTurn) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown app-server thread: ${threadId}`);
    }

    thread.activeTurnId = undefined;
    if (thread.shadow) {
      const workspaceDiff = await diffShadowWorkspace(thread.shadow);
      thread.diff = workspaceDiff.diff || thread.diff;
      thread.changedFiles = workspaceDiff.changedFiles;
    }
    thread.finalMessage = (pending.completedMessages.at(-1) || pending.textDeltas.join("") || thread.finalMessage).trim();

    if (thread.diff) {
      this.sink.emit({ type: "diff", threadId, diff: thread.diff });
    }

    const durationMs = Date.now() - pending.startedAt;
    thread.lastTurnDurationMs = durationMs;
    this.sink.emit({
      type: "completed",
      threadId,
      turnId: pending.turnId,
      durationMs,
      finalMessage: thread.finalMessage,
      diff: thread.diff
    });

    return {
      threadId,
      provider: this.name,
      finalMessage: thread.finalMessage,
      diff: thread.diff,
      turnId: pending.turnId,
      durationMs,
      changedFiles: thread.changedFiles
    };
  }

  private maybeResolveTurn(threadId: string) {
    const pending = this.pendingTurns.get(threadId);
    if (!pending?.completedTurn || !pending.turnId) {
      return;
    }

    this.pendingTurns.delete(threadId);
    clearTimeout(pending.timer);
    void this.completeTurn(threadId, pending).then(pending.resolve, pending.reject);
  }

  private async waitForInterruptedTurn(threadId: string, pending: PendingTurn) {
    const thread = this.threads.get(threadId);
    await new Promise<void>((resolvePromise) => {
      const timeout = setTimeout(() => {
        if (this.pendingTurns.get(threadId) === pending) {
          this.pendingTurns.delete(threadId);
          clearTimeout(pending.timer);
          if (thread) thread.activeTurnId = undefined;
        }
        originalResolve({
          threadId,
          provider: this.name,
          finalMessage: "",
          diff: "",
          turnId: pending.turnId,
          durationMs: Date.now() - pending.startedAt,
          changedFiles: []
        });
        resolvePromise();
      }, 5000);

      const originalResolve = pending.resolve;
      const originalReject = pending.reject;
      pending.resolve = (result) => {
        clearTimeout(timeout);
        if (thread) thread.activeTurnId = undefined;
        originalResolve(result);
        resolvePromise();
      };
      pending.reject = (error) => {
        clearTimeout(timeout);
        if (thread) thread.activeTurnId = undefined;
        originalReject(error);
        resolvePromise();
      };
    });
  }
}

function toCodexSandbox(sandbox: SandboxMode) {
  if (sandbox === "read-only") return "read-only";
  if (sandbox === "danger-full-access") return "danger-full-access";
  return "workspace-write";
}

function resolveWorkspaceMode(mode: WorkspaceMode | undefined): WorkspaceMode {
  return mode === "direct" ? "direct" : "shadow";
}

function normalizeModels(value: unknown): CodexModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const model = item as Record<string, unknown>;
    const id = typeof model.id === "string" ? model.id : "";
    const name = typeof model.model === "string" ? model.model : "";
    if (!id || !name) return [];
    return [
      {
        id,
        model: name,
        displayName: typeof model.displayName === "string" && model.displayName ? model.displayName : name,
        description: typeof model.description === "string" ? model.description : "",
        supportedReasoningEfforts: normalizeReasoningEfforts(model.supportedReasoningEfforts),
        defaultReasoningEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : "",
        isDefault: model.isDefault === true
      }
    ];
  });
}

function normalizeReasoningEfforts(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const effort = item as Record<string, unknown>;
    if (typeof effort.reasoningEffort !== "string" || !effort.reasoningEffort) return [];
    return [
      {
        reasoningEffort: effort.reasoningEffort,
        description: typeof effort.description === "string" ? effort.description : ""
      }
    ];
  });
}

function modelConfig(options: StartThreadOptions) {
  return options.reasoningEffort ? { model_reasoning_effort: options.reasoningEffort } : null;
}

function toCodexSandboxPolicy(root: string, workspaceMode: WorkspaceMode, sandbox: SandboxMode) {
  if (workspaceMode === "direct" && sandbox === "danger-full-access") {
    return {
      type: "dangerFullAccess"
    };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [root],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function changedFilesFromDiff(diff: string) {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match?.[2]) files.add(match[2]);
  }
  return Array.from(files);
}

function extractText(params: Record<string, unknown> | undefined) {
  if (!params) return "";
  for (const key of ["delta", "text", "message"]) {
    if (typeof params[key] === "string") return params[key] as string;
  }
  const item = params.item as Record<string, unknown> | undefined;
  if (typeof item?.text === "string") return item.text;
  return "";
}

function extractThreadId(params: Record<string, unknown> | undefined) {
  if (!params) return undefined;
  if (typeof params.threadId === "string") return params.threadId;
  const turn = params.turn as Record<string, unknown> | undefined;
  if (typeof turn?.threadId === "string") return turn.threadId;
  const item = params.item as Record<string, unknown> | undefined;
  if (typeof item?.threadId === "string") return item.threadId;
  return undefined;
}

function extractTurnId(params: Record<string, unknown> | undefined) {
  if (!params) return undefined;
  if (typeof params.turnId === "string") return params.turnId;
  const turn = params.turn as Record<string, unknown> | undefined;
  if (typeof turn?.id === "string") return turn.id;
  const item = params.item as Record<string, unknown> | undefined;
  if (typeof item?.turnId === "string") return item.turnId;
  return undefined;
}

function isAgentMessageItem(item: unknown) {
  return Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "agentMessage");
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function buildPrompt(options: RunTurnOptions) {
  const selectedElements = selectedElementContexts(options);
  const context = selectedElements.map(compactSelectedElementContext);
  return [
    "User request:",
    options.input,
    "",
    "Selected element contexts, in selection order:",
    JSON.stringify(context, null, 2)
  ].join("\n");
}

export function compactSelectedElementContext(selected: SelectedElementContext) {
  return {
    selector: compactCodexSelectorPath(selected.selector || selected.pathSelector || ""),
    elementSource: selected.elementSource
  };
}

export function compactCodexSelectorPath(selector: string) {
  return selector
    .split(/\s*>\s*/)
    .filter(Boolean)
    .slice(-3)
    .map((part) => part.replace(/:nth-of-type\(\d+\)/g, ""))
    .join(" > ");
}

function selectedElementContexts(options: RunTurnOptions) {
  if (options.selectedElementContexts?.length) return options.selectedElementContexts;
  return options.selectedElementContext ? [options.selectedElementContext] : [];
}

function buildTurnInput(options: RunTurnOptions) {
  const input: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: buildPrompt(options),
      text_elements: []
    }
  ];

  for (const attachment of options.attachments || []) {
    if (attachment.type !== "localImage" || !attachment.path) continue;
    input.push({
      type: "localImage",
      path: attachment.path,
      detail: "high"
    });
  }

  return input;
}

export function eventFromError(error: unknown): CodexEvent {
  return {
    type: "error",
    message: error instanceof Error ? error.message : String(error)
  };
}
