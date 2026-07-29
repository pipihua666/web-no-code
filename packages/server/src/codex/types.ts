export type ProviderMode = "app-server";

export type ProviderName = "app-server" | "unavailable";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type WorkspaceMode = "shadow" | "direct";

export type SelectedElementContext = {
  tagName?: string;
  selector?: string;
  pathSelector?: string;
  contextSelector?: string;
  text?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  attributes?: Record<string, string>;
  sourceAttributes?: Record<string, string>;
  styles?: Record<string, string>;
  styleSources?: Record<
    string,
    {
      file?: string;
      line?: number;
      column?: number;
      selector?: string;
      value?: string;
    }
  >;
  source?: {
    file?: string;
    line?: number;
    column?: number;
  };
  elementSource?: {
    file?: string;
    line?: number;
    column?: number;
  };
  url?: string;
};

export type StartThreadOptions = {
  cwd: string;
  sandbox?: SandboxMode;
  model?: string;
  reasoningEffort?: string;
  mode?: ProviderMode;
  workspaceMode?: WorkspaceMode;
};

export type ResumeThreadOptions = StartThreadOptions & {
  threadId: string;
};

export type RunTurnOptions = {
  threadId: string;
  input: string;
  attachments?: Array<{
    type: "localImage";
    path: string;
    name?: string;
  }>;
  selectedElementContext?: SelectedElementContext | null;
};

export type ProviderStatus = {
  provider: ProviderName;
  mode: ProviderMode;
  available: boolean;
  reason?: string;
  codexVersion?: string;
};

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
  defaultReasoningEffort: string;
  isDefault: boolean;
};

export type CodexReasoningEffort = {
  reasoningEffort: string;
  description: string;
};

export type ThreadHandle = {
  threadId: string;
  provider: ProviderName;
};

export type TurnResult = {
  threadId: string;
  provider: ProviderName;
  finalMessage: string;
  diff: string;
  turnId?: string;
  durationMs?: number;
  changedFiles?: string[];
  appliedFiles?: string[];
};

export type SteerTurnResult = {
  threadId: string;
  turnId?: string;
  steered: boolean;
};

export type CodexTurnStatus = {
  threadId: string;
  active: boolean;
  turnId?: string;
  startedAt?: number;
  finalMessage?: string;
  durationMs?: number;
};

export type CodexEvent =
  | {
      type: "provider";
      provider: ProviderName;
      message: string;
    }
  | {
      type: "status";
      threadId?: string;
      message: string;
    }
  | {
      type: "delta";
      threadId?: string;
      text: string;
    }
  | {
      type: "diff";
      threadId?: string;
      diff: string;
    }
  | {
      type: "error";
      threadId?: string;
      message: string;
    }
  | {
      type: "completed";
      threadId?: string;
      finalMessage: string;
      diff: string;
      turnId?: string;
      durationMs?: number;
    }
  | {
      type: "app-server-notification";
      threadId?: string;
      turnId?: string;
      method: string;
      params?: unknown;
    };

export interface CodexProvider {
  readonly name: ProviderName;
  status(): Promise<ProviderStatus>;
  listModels(): Promise<CodexModel[]>;
  startThread(options: StartThreadOptions): Promise<ThreadHandle>;
  resumeThread?(options: ResumeThreadOptions): Promise<ThreadHandle>;
  runTurn(options: RunTurnOptions): Promise<TurnResult>;
  steerTurn(options: RunTurnOptions): Promise<SteerTurnResult>;
  getTurnStatus(threadId: string): CodexTurnStatus;
  interrupt(threadId: string): Promise<void>;
  getDiff(threadId: string): Promise<string>;
  dispose(): Promise<void>;
}

export type EventSink = {
  emit(event: CodexEvent): void;
};
