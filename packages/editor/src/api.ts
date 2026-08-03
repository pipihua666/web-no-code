import type { CodexEvent, SelectedElementContext } from "@web-no-code/server/codex/types";

export type ProviderMode = "app-server";
const API_FALLBACK_ORIGIN = "http://127.0.0.1:4317";

export type RegisteredTarget = {
  root: string;
  url: string;
  width?: 375 | 750 | "full";
  aliases?: TargetAlias[];
  updatedAt: number;
};

export type TargetAlias = {
  find: string;
  replacement: string;
};

export type WorkspaceAgentsEvent = {
  type: "agents-updated";
  root: string;
  content: string;
  exists: boolean;
};

export async function getCodexStatus(mode: ProviderMode) {
  return request(`/api/codex/status?mode=${encodeURIComponent(mode)}`);
}

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
};

export async function getCodexModels(mode: ProviderMode) {
  return request(`/api/codex/models?mode=${encodeURIComponent(mode)}`) as Promise<{ models: CodexModel[] }>;
}

export async function getRegisteredTargets(root = "") {
  const query = root ? `?root=${encodeURIComponent(root)}` : "";
  return request(`/api/targets${query}`) as Promise<{ targets: RegisteredTarget[] }>;
}

export async function getCodexSkills() {
  return request("/api/codex/skills") as Promise<{
    skills: Array<{ name: string; description: string; path: string }>;
  }>;
}

export async function getWorkspaceAgents(root: string) {
  return request(`/api/workspace/agents?root=${encodeURIComponent(root)}`) as Promise<{
    root: string;
    path: string;
    content: string;
    exists: boolean;
    global: {
      path: string;
      content: string;
      exists: boolean;
    };
  }>;
}

export async function updateWorkspaceAgents(root: string, content: string, keepalive = false) {
  return request("/api/workspace/agents", {
    method: "PUT",
    body: JSON.stringify({ root, content }),
    keepalive
  }) as Promise<{ root: string; path: string; content: string; exists: boolean }>;
}

export async function updateGlobalAgents(content: string) {
  return request("/api/global/agents", {
    method: "PUT",
    body: JSON.stringify({ content })
  }) as Promise<{ path: string; content: string; exists: boolean }>;
}

export async function startCodexThread(payload: {
  cwd: string;
  mode: ProviderMode;
  model?: string;
  reasoningEffort?: string;
  sandbox?: string;
  workspaceMode?: "shadow" | "direct";
}) {
  return request("/api/codex/thread", {
    method: "POST",
    body: JSON.stringify(payload)
  }) as Promise<{ threadId: string; provider: string }>;
}

export async function resumeCodexThread(payload: {
  threadId: string;
  cwd: string;
  mode: ProviderMode;
  model?: string;
  reasoningEffort?: string;
  sandbox?: string;
  workspaceMode?: "shadow" | "direct";
}) {
  return request("/api/codex/thread/resume", {
    method: "POST",
    body: JSON.stringify(payload)
  }) as Promise<{ threadId: string; provider: string }>;
}

export async function runCodexTurn(payload: {
  threadId: string;
  input: string;
  attachments?: Array<{ type: "localImage"; path: string; name?: string }>;
  selectedElementContext: SelectedElementContext | null;
}) {
  return request("/api/codex/turn", {
    method: "POST",
    body: JSON.stringify(payload)
  }) as Promise<{
    threadId: string;
    provider: string;
    finalMessage: string;
    diff: string;
    turnId?: string;
    durationMs?: number;
    changedFiles?: string[];
    appliedFiles?: string[];
  }>;
}

export async function steerCodexTurn(payload: {
  threadId: string;
  input: string;
  attachments?: Array<{ type: "localImage"; path: string; name?: string }>;
  selectedElementContext: SelectedElementContext | null;
}) {
  return request("/api/codex/steer", {
    method: "POST",
    body: JSON.stringify(payload)
  }) as Promise<{ threadId: string; turnId?: string; steered: boolean }>;
}

export async function getCodexThreadStatus(threadId: string) {
  return request(`/api/codex/thread/${encodeURIComponent(threadId)}/status`) as Promise<{
    threadId: string;
    active: boolean;
    turnId?: string;
    startedAt?: number;
    finalMessage?: string;
    durationMs?: number;
  }>;
}

export async function interruptCodexTurn(threadId: string) {
  return request("/api/codex/interrupt", {
    method: "POST",
    body: JSON.stringify({ threadId })
  }) as Promise<{ ok: true }>;
}

export async function uploadCodexAttachment(file: File) {
  const data = new FormData();
  data.set("attachment", file);
  return fetchJsonWithFallback("/api/codex/attachments", {
    method: "POST",
    body: data
  }) as Promise<{
    attachment: {
      type: "localImage";
      path: string;
      name?: string;
    };
  }>;
}

export async function previewStylePatch(payload: {
  root: string;
  file: string;
  selector: string;
  selectors?: string[];
  property: string;
  value: string;
  line?: number;
  column?: number;
}) {
  return request("/api/patch/style/preview", {
    method: "POST",
    body: JSON.stringify(payload)
  }) as Promise<{ file: string; before: string; after: string; diff: string }>;
}

export async function applyStylePatch(payload: {
  root: string;
  file: string;
  selector: string;
  selectors?: string[];
  property: string;
  value: string;
  line?: number;
  column?: number;
}) {
  return request("/api/patch/style/apply", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function applyTextPatch(payload: {
  root: string;
  file: string;
  search: string;
  searches?: string[];
  line?: number;
  attribute?: string;
  replace: string;
}) {
  return request("/api/patch/text/apply", {
    method: "POST",
    body: JSON.stringify(payload)
  }) as Promise<{ file: string; before: string; after: string; diff: string }>;
}

export async function uploadAsset(root: string, file: File) {
  const data = new FormData();
  data.set("root", root);
  data.set("asset", file);
  return fetchJsonWithFallback("/api/assets", {
    method: "POST",
    body: data
  }) as Promise<{ filename: string; relativePath: string }>;
}

export async function replaceAsset(root: string, target: string, file: File, targets: string[] = []) {
  const data = new FormData();
  data.set("root", root);
  data.set("target", target);
  if (targets.length) data.set("targets", JSON.stringify(targets));
  data.set("asset", file);
  return fetchJsonWithFallback("/api/assets/replace", {
    method: "POST",
    body: data
  }) as Promise<{ relativePath: string; path: string }>;
}

export function createEventStream(
  onEvent: (event: CodexEvent) => void,
  onWorkspaceEvent?: (event: WorkspaceAgentsEvent) => void
) {
  const source = new EventSource(eventStreamUrl());
  source.addEventListener("codex", (event) => {
    onEvent(JSON.parse((event as MessageEvent).data) as CodexEvent);
  });
  source.addEventListener("workspace", (event) => {
    onWorkspaceEvent?.(JSON.parse((event as MessageEvent).data) as WorkspaceAgentsEvent);
  });
  return () => source.close();
}

function eventStreamUrl() {
  return "/events";
}

async function request(path: string, init: RequestInit = {}) {
  return fetchJsonWithFallback(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers
    }
  });
}

async function fetchJsonWithFallback(path: string, init: RequestInit = {}) {
  try {
    return await fetchJson(path, init);
  } catch (error) {
    if (!shouldFallbackToApiOrigin(path, error)) throw error;
    try {
      return await fetchJson(`${API_FALLBACK_ORIGIN}${path}`, init);
    } catch (fallbackError) {
      throw new Error(formatFetchError(path, error, fallbackError));
    }
  }
}

async function fetchJson(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  const isJson = contentType.includes("application/json") || /^[\s\n\r]*[{\[]/.test(text);
  if (!isJson) {
    throw new Error(`Expected JSON from ${path}, got ${contentType || "unknown content type"}: ${text.slice(0, 80)}`);
  }
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error || response.statusText);
  return data;
}

function shouldFallbackToApiOrigin(path: string, error: unknown) {
  if (!path.startsWith("/api/")) return false;
  if (window.location.origin === API_FALLBACK_ORIGIN) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Expected JSON") || message.includes("Failed to fetch") || message.includes("NetworkError");
}

function formatFetchError(path: string, firstError: unknown, fallbackError: unknown) {
  const firstMessage = errorMessage(firstError);
  const fallbackMessage = errorMessage(fallbackError);
  return [
    `Request failed: ${path}`,
    `same-origin: ${firstMessage}`,
    `fallback ${API_FALLBACK_ORIGIN}${path}: ${fallbackMessage}`,
    "Check that the web-no-code server is running and reachable from this browser."
  ].join(" | ");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
