import { applyShadowFiles, diffShadowWorkspace, type ShadowWorkspace } from "../workspace/shadow-workspace";
import { emitCodexEvent } from "../events";
import { AppServerProvider } from "./app-server-provider";
import type {
  CodexProvider,
  CodexModel,
  EventSink,
  ProviderMode,
  ProviderName,
  ProviderStatus,
  RunTurnOptions,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHandle,
  TurnResult
} from "./types";

type ProviderWithShadow = CodexProvider & {
  getShadow(threadId: string): ShadowWorkspace | null;
  getChangedFiles(threadId: string): string[];
};

const sink: EventSink = {
  emit: emitCodexEvent
};

export class CodexBridge {
  private readonly appServer = new AppServerProvider(sink);
  private readonly threadProviders = new Map<string, ProviderWithShadow>();
  private lastStatus: ProviderStatus | null = null;

  async status(mode: ProviderMode = "app-server") {
    const status = await this.resolveStatus(mode);
    this.lastStatus = status;
    return status;
  }

  async warmup(mode: ProviderMode = "app-server") {
    const status = await this.resolveStatus(mode);
    this.lastStatus = status;
    return status;
  }

  async listModels(mode: ProviderMode = "app-server") {
    const provider = await this.selectProvider(mode);
    return await provider.listModels();
  }

  async startThread(options: StartThreadOptions): Promise<ThreadHandle> {
    const provider = await this.selectProvider(options.mode || "app-server");
    const thread = await provider.startThread(options);
    this.threadProviders.set(thread.threadId, provider);
    return thread;
  }

  async resumeThread(threadId: string, options: Omit<ResumeThreadOptions, "threadId">): Promise<ThreadHandle> {
    const provider = await this.selectProvider(options.mode || "app-server");
    const thread = provider.resumeThread
      ? await provider.resumeThread({ ...options, threadId })
      : await provider.startThread(options);
    this.threadProviders.delete(threadId);
    this.threadProviders.set(thread.threadId, provider);
    return thread;
  }

  async runTurn(options: RunTurnOptions): Promise<TurnResult> {
    const provider = this.threadProviders.get(options.threadId);
    if (!provider) {
      throw new Error(`No provider registered for thread ${options.threadId}`);
    }
    const result = await provider.runTurn(options);
    if (!result.diff) return result;

    const applied = await this.applyThread(options.threadId);
    return {
      ...result,
      appliedFiles: applied.appliedFiles
    };
  }

  async getDiff(threadId: string) {
    const provider = this.threadProviders.get(threadId);
    if (!provider) {
      throw new Error(`No provider registered for thread ${threadId}`);
    }
    return await provider.getDiff(threadId);
  }

  respondToServerRequest(requestId: number | string, result: unknown) {
    for (const provider of this.threadProviders.values()) {
      if (provider.respondToServerRequest) {
        provider.respondToServerRequest(requestId, result);
        return;
      }
    }
    throw new Error(`No provider available for request ${requestId}`);
  }

  async steerTurn(options: RunTurnOptions) {
    const provider = this.threadProviders.get(options.threadId);
    if (!provider) {
      throw new Error(`No provider registered for thread ${options.threadId}`);
    }
    return await provider.steerTurn(options);
  }

  getTurnStatus(threadId: string) {
    const provider = this.threadProviders.get(threadId);
    return provider?.getTurnStatus(threadId) || { threadId, active: false };
  }

  async applyThread(threadId: string) {
    const provider = this.threadProviders.get(threadId);
    if (!provider) {
      throw new Error(`No provider registered for thread ${threadId}`);
    }

    const shadow = provider.getShadow(threadId);
    if (!shadow) {
      const changedFiles = provider.getChangedFiles(threadId);
      emitCodexEvent({
        type: "status",
        threadId,
        message: "Codex edited the source workspace directly"
      });
      return {
        appliedFiles: changedFiles,
        diff: await provider.getDiff(threadId)
      };
    }

    const latest = await diffShadowWorkspace(shadow);
    const changedFiles = latest.changedFiles.length ? latest.changedFiles : provider.getChangedFiles(threadId);
    await applyShadowFiles(shadow, changedFiles);
    const status = {
      appliedFiles: changedFiles,
      diff: latest.diff
    };
    emitCodexEvent({
      type: "status",
      threadId,
      message: `Applied ${changedFiles.length} changed file(s) to source workspace`
    });
    return status;
  }

  async interrupt(threadId: string) {
    const provider = this.threadProviders.get(threadId);
    if (!provider) {
      throw new Error(`No provider registered for thread ${threadId}`);
    }
    await provider.interrupt(threadId);
  }

  async dispose() {
    await this.appServer.dispose();
  }

  getLastStatus() {
    return this.lastStatus;
  }

  private async selectProvider(_mode: ProviderMode): Promise<ProviderWithShadow> {
    const status = await this.appServer.status();
    if (!status.available) throw new Error(status.reason || "app-server unavailable");
    this.lastStatus = status;
    return this.appServer;
  }

  private async resolveStatus(_mode: ProviderMode): Promise<ProviderStatus> {
    const appStatus = await this.appServer.warmup();
    if (appStatus.available) return appStatus;

    return {
      provider: "unavailable" as ProviderName,
      mode: "app-server",
      available: false,
      reason: appStatus.reason || "app-server unavailable"
    };
  }
}

export const codexBridge = new CodexBridge();
