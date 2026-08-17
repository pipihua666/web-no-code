import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Crosshair,
  X,
  Eye,
  EyeOff,
  FileCode2,
  Globe2,
  ImageUp,
  Loader2,
  Maximize2,
  Monitor,
  MousePointer2,
  Move,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  SquareCode,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  FormEvent as ReactFormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  SetStateAction
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  applyStylePatch,
  applyTextPatch,
  createEventStream,
  getCodexModels,
  getCodexStatus,
  getCodexSkills,
  getCodexThreadStatus,
  getRegisteredTargets,
  getWorkspaceAgents,
  interruptCodexTurn,
  resumeCodexThread,
  runCodexTurn,
  steerCodexTurn,
  startCodexThread,
  updateGlobalAgents,
  updateWorkspaceAgents,
  replaceAsset,
  uploadCodexAttachment,
} from "./api";
import type { CodexModel, RegisteredTarget, TargetAlias, WorkspaceAgentsEvent } from "./api";
import type { CodexEvent, SelectedElementContext } from "@web-no-code/server/codex/types";
import { resolveAssetPreviewUrl, resolveBackgroundAssetSource } from "./asset-preview";
import { displaySelector, lastDisplayedSelectors, leafSelector, selectorBreadcrumbs } from "./selector-path";

const DEFAULT_TARGET = "about:blank";
const DEFAULT_ROOT = "";
const DEFAULT_APP_TITLE = "Web No Code";
const CODEX_SANDBOX_STORAGE_KEY = "web-no-code-codex-sandbox-v2";
const CODEX_WORKSPACE_MODE_STORAGE_KEY = "web-no-code-codex-workspace-mode-v2";
const CODEX_MODEL_STORAGE_KEY = "web-no-code-codex-model-v1";
const CODEX_REASONING_EFFORT_STORAGE_KEY = "web-no-code-codex-reasoning-effort-v1";
const CODEX_SESSION_STORAGE_KEY = "web-no-code-codex-session-v1";
const EDITOR_TARGET_STORAGE_KEY = "web-no-code-editor-target-root";
const SMALL_SCREEN_MEDIA_QUERY = "(max-width: 1299px)";
const MAX_CODEX_TASKS = 3;
const CODEX_SEND_DEBOUNCE_MS = 400;
const CODEX_RECOVERY_POLL_INTERVAL_MS = 10_000;
const CODEX_SESSION_WRITE_DEBOUNCE_MS = 750;
const DEVICE_PRESETS = [
  { label: "375px", value: 375 },
  { label: "750px", value: 750 },
  { label: "Full", value: "full" }
] as const;
const EDITOR_QUERY_KEYS = new Set(["width"]);
type DeviceWidth = (typeof DEVICE_PRESETS)[number]["value"];

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  elapsedMs?: number;
  elements?: ElementSummary[];
  element?: ElementSummary | null;
};

type ElementSummary = {
  tagName: string;
  selector: string;
  source: string;
};

type CodexSkill = {
  name: string;
  description: string;
  path: string;
};

type CodexAttachment = {
  id: string;
  name: string;
  previewUrl: string;
  path: string;
  signature: string;
};

type PreviewQueryParam = {
  id: string;
  key: string;
  value: string;
};

type SiblingOption = {
  selector: string;
  label: string;
  text?: string;
};

type SiblingPickerState = {
  requestId: number;
  currentSelector: string;
  parentLabel: string;
  left: number;
  top: number;
  loading: boolean;
  options: SiblingOption[];
};

type CodexTask = {
  id: string;
  title: string;
  threadId: string;
  input: string;
  attachments: CodexAttachment[];
  chatMessages: ChatMessage[];
  busy: boolean;
  turnStartedAt?: number;
  createdAt: number;
  updatedAt: number;
};

type CodexSessionSnapshot = {
  activeTaskId: string;
  tasks: CodexTask[];
};

type LeftView = "setup" | "codex";
type CodexSandbox = "workspace-write" | "danger-full-access";
type CodexWorkspaceMode = "shadow" | "direct";

let chatId = 0;
let previewQueryParamId = 0;

const CodexChatMessageView = memo(function CodexChatMessageView({
  message,
  streaming,
  activityElapsedMs
}: {
  message: ChatMessage;
  streaming: boolean;
  activityElapsedMs: number;
}) {
  const elements = chatMessageElements(message);
  const activity = streaming ? (
    <div className="codex-live-activity" aria-label="Codex is working">
      <Loader2 className="spin" size={13} aria-hidden="true" />
      <span>{codexActivityLabel(activityElapsedMs, Boolean(message.content))}</span>
      <time>{formatElapsedTime(activityElapsedMs)}</time>
    </div>
  ) : null;
  return (
    <article className={`chat-message ${message.role}`}>
      <div className="chat-message-meta">
        <span>{message.role === "user" ? "You" : "Codex"}</span>
        {message.elapsedMs != null ? <small>{formatElapsedTime(message.elapsedMs)}</small> : null}
      </div>
      {elements.length ? (
        <div className="chat-element-summaries" aria-label={`${elements.length} selected element${elements.length === 1 ? "" : "s"}`}>
          {elements.map((element, index) => (
            <div className="chat-element-summary" key={`${element.selector}:${element.source}:${index}`}>
              <div className="chat-element-summary-heading">
                {elements.length > 1 ? <span>{index + 1}</span> : null}
                <strong>{element.tagName}</strong>
              </div>
              <code>{element.selector}</code>
              {element.source ? <small>{element.source}</small> : null}
            </div>
          ))}
        </div>
      ) : null}
      {message.role === "assistant" ? (
        message.content ? (
          streaming ? (
            <>
              <p className="streaming-response">{message.content}</p>
              {activity}
            </>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          )
        ) : (
          activity || <p className="streaming-placeholder">Thinking...</p>
        )
      ) : (
        <p>{message.content}</p>
      )}
    </article>
  );
});

export default function App() {
  const persistedCodexSession = useMemo(() => readCodexSessionStorage(DEFAULT_ROOT), []);
  const editorTargetRootRef = useRef(readEditorTargetRootStorage());
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const codexFileInputRef = useRef<HTMLInputElement | null>(null);
  const chatPanelRef = useRef<HTMLDivElement | null>(null);
  const codexTaskListRef = useRef<HTMLDivElement | null>(null);
  const codexTaskTabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingCodexTaskScrollRef = useRef(persistedCodexSession.activeTaskId);
  const skillMenuRef = useRef<HTMLDivElement | null>(null);
  const codexModelPickerRef = useRef<HTMLDivElement | null>(null);
  const codexContextListRef = useRef<HTMLDivElement | null>(null);
  const selectorBreadcrumbRef = useRef<HTMLDivElement | null>(null);
  const siblingPickerRef = useRef<HTMLDivElement | null>(null);
  const sourceFileDisplayRef = useRef<HTMLElement | null>(null);
  const siblingPickerRequestIdRef = useRef(0);
  const styleInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const styleFocusValueRef = useRef<{ property: string; value: string } | null>(null);
  const skipStyleBlurCommitRef = useRef<{ property: string; value: string } | null>(null);
  const addCodexAttachmentsRef = useRef<(files: File[]) => Promise<void>>(async () => {});
  const codexAttachmentsRef = useRef<CodexAttachment[]>([]);
  const codexTurnBusyRef = useRef<Record<string, boolean>>({});
  const codexLastSubmitAtRef = useRef<Record<string, number>>({});
  const codexTasksRef = useRef<CodexTask[]>(persistedCodexSession.tasks);
  const activeCodexTaskIdRef = useRef(persistedCodexSession.activeTaskId);
  const codexThreadTaskIdsRef = useRef<Record<string, string>>({});
  const codexDeltaBuffersRef = useRef<Record<string, string>>({});
  const codexDeltaFlushFrameRef = useRef(0);
  const codexSessionWriteTimerRef = useRef(0);
  const pendingCodexSessionWriteRef = useRef<{ root: string; snapshot: CodexSessionSnapshot } | null>(null);
  const workspaceRootRef = useRef(DEFAULT_ROOT);
  const agentsInstructionsRef = useRef("");
  const draftAgentsInstructionsRef = useRef("");
  const globalAgentsInstructionsRef = useRef("");
  const draftGlobalAgentsInstructionsRef = useRef("");
  const openSourceRef = useRef<() => void>(() => {});
  const pendingAttachmentSignaturesRef = useRef<Set<string>>(new Set());
  const lastPasteHandledAtRef = useRef(0);
  const [targetUrl, setTargetUrl] = useState(DEFAULT_TARGET);
  const [loadedUrl, setLoadedUrl] = useState(DEFAULT_TARGET);
  const [previewUrl, setPreviewUrl] = useState(DEFAULT_TARGET);
  const [previewUrlInput, setPreviewUrlInput] = useState(DEFAULT_TARGET);
  const [previewQueryEditor, setPreviewQueryEditor] = useState<{
    open: boolean;
    params: PreviewQueryParam[];
    error: string;
  }>({ open: false, params: [], error: "" });
  const [targetTitle, setTargetTitle] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState(DEFAULT_ROOT);
  const [targetAliases, setTargetAliases] = useState<TargetAlias[]>([]);
  const [deviceWidth, setDeviceWidth] = useState<DeviceWidth>(() => parseDeviceWidth(window.location.search));
  const [providerStatus, setProviderStatus] = useState("Checking provider");
  const [providerName, setProviderName] = useState("app-server");
  const [leftView, setLeftView] = useState<LeftView>("codex");
  const [inspectorEnabled, setInspectorEnabled] = useState(false);
  const [temporaryInspectorMode, setTemporaryInspectorMode] = useState<"select" | "drag" | null>(null);
  const [dragEnabled, setDragEnabled] = useState(false);
  const [selected, setSelected] = useState<SelectedElementContext | null>(null);
  const [selectedElements, setSelectedElements] = useState<SelectedElementContext[]>([]);
  const [siblingPicker, setSiblingPicker] = useState<SiblingPickerState | null>(null);
  const [codexElementEnabled, setCodexElementEnabled] = useState(false);
  const [codexElementVisible, setCodexElementVisible] = useState(false);
  const [styleFile, setStyleFile] = useState("");
  const [styleProperty, setStyleProperty] = useState("background-color");
  const [styleValue, setStyleValue] = useState("#ffbf47");
  const [focusedStyleProperty, setFocusedStyleProperty] = useState("");
  const [codexSessionWorkspaceRoot, setCodexSessionWorkspaceRoot] = useState(() => normalizeCodexWorkspaceRoot(DEFAULT_ROOT));
  const [codexTasks, setCodexTasks] = useState<CodexTask[]>(persistedCodexSession.tasks);
  const [activeCodexTaskId, setActiveCodexTaskId] = useState(persistedCodexSession.activeTaskId);
  const [agentsInstructions, setAgentsInstructions] = useState("");
  const [draftAgentsInstructions, setDraftAgentsInstructions] = useState("");
  const [agentsInstructionsStatus, setAgentsInstructionsStatus] = useState("Not loaded");
  const [globalAgentsInstructions, setGlobalAgentsInstructions] = useState("");
  const [draftGlobalAgentsInstructions, setDraftGlobalAgentsInstructions] = useState("");
  const [globalAgentsInstructionsStatus, setGlobalAgentsInstructionsStatus] = useState("Not loaded");
  const [codexSandbox, setCodexSandbox] = useState<CodexSandbox>(readCodexSandboxStorage);
  const [codexWorkspaceMode, setCodexWorkspaceMode] = useState<CodexWorkspaceMode>(readCodexWorkspaceModeStorage);
  const [draftCodexSandbox, setDraftCodexSandbox] = useState<CodexSandbox>(readCodexSandboxStorage);
  const [draftCodexWorkspaceMode, setDraftCodexWorkspaceMode] = useState<CodexWorkspaceMode>(readCodexWorkspaceModeStorage);
  const [codexModel, setCodexModel] = useState(readCodexModelStorage);
  const [codexReasoningEffort, setCodexReasoningEffort] = useState(readCodexReasoningEffortStorage);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [codexModelsLoading, setCodexModelsLoading] = useState(false);
  const [codexModelPickerOpen, setCodexModelPickerOpen] = useState(false);
  const [codexSettingsOpen, setCodexSettingsOpen] = useState(false);
  const [codexSettingsSaving, setCodexSettingsSaving] = useState(false);
  const [agentsViewerMode, setAgentsViewerMode] = useState<"global" | "project" | null>(null);
  const [cssRulesDrawerOpen, setCssRulesDrawerOpen] = useState(
    () => !window.matchMedia(SMALL_SCREEN_MEDIA_QUERY).matches
  );
  const [skills, setSkills] = useState<CodexSkill[]>([]);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillTriggerStart, setSkillTriggerStart] = useState<number | null>(null);
  const [skillActiveIndex, setSkillActiveIndex] = useState(0);
  const [codexPasteStatus, setCodexPasteStatus] = useState("");
  const [codexActivityNow, setCodexActivityNow] = useState(Date.now());
  const [pendingDeleteCodexTaskId, setPendingDeleteCodexTaskId] = useState("");
  const [assetPreviewVersion, setAssetPreviewVersion] = useState(0);
  const [imageUrlDialog, setImageUrlDialog] = useState<{ open: boolean; value: string; error: string }>({
    open: false,
    value: "",
    error: ""
  });
  const activeCodexTask = useMemo(
    () => codexTasks.find((task) => task.id === activeCodexTaskId) || codexTasks[0],
    [activeCodexTaskId, codexTasks]
  );
  const threadId = activeCodexTask?.threadId || "";
  const codexInput = activeCodexTask?.input || "";
  const codexAttachments = activeCodexTask?.attachments || [];
  const chatMessages = activeCodexTask?.chatMessages || [];
  const busy = Boolean(activeCodexTask?.busy);
  const codexActivityElapsedMs = busy && activeCodexTask
    ? Math.max(0, codexActivityNow - (activeCodexTask.turnStartedAt || codexActivityNow))
    : 0;
  const canCreateCodexTask = codexTasks.length < MAX_CODEX_TASKS;
  const pendingDeleteCodexTask = pendingDeleteCodexTaskId
    ? codexTasks.find((task) => task.id === pendingDeleteCodexTaskId) || null
    : null;
  const codexSettingsDirty =
    draftCodexSandbox !== codexSandbox ||
    draftCodexWorkspaceMode !== codexWorkspaceMode ||
    draftAgentsInstructions !== agentsInstructions ||
    draftGlobalAgentsInstructions !== globalAgentsInstructions;
  const projectAgentsStats = useMemo(() => getDocumentStats(draftAgentsInstructions), [draftAgentsInstructions]);
  const globalAgentsStats = useMemo(() => getDocumentStats(draftGlobalAgentsInstructions), [draftGlobalAgentsInstructions]);

  const selectedStyles = useMemo(() => selected?.styles || {}, [selected]);
  const styleEntries = useMemo(
    () => Object.entries(selectedStyles).filter(([property, value]) => shouldShowStyleRule(selected, property, value)),
    [selected, selectedStyles]
  );
  const styleProperties = useMemo(() => styleEntries.map(([property]) => property), [styleEntries]);
  const selectedImage = useMemo(
    () => resolveSelectedImage(selected, styleProperty, styleValue, targetUrl, targetAliases, workspaceRoot, assetPreviewVersion),
    [selected, styleProperty, styleValue, targetUrl, targetAliases, workspaceRoot, assetPreviewVersion]
  );
  const codexSendLabel = busy ? (codexInput.trim() || codexAttachments.length ? "Steer current task" : "Stop current task") : "Send";
  const sourceLocation = useMemo(
    () => resolveSourceLocation(workspaceRoot, selected, styleProperty),
    [workspaceRoot, selected, styleProperty]
  );
  const displayedStyleFile = formatSourceFileForDisplay(styleFile, workspaceRoot);

  useEffect(() => {
    const sourceFileDisplay = sourceFileDisplayRef.current;
    if (!sourceFileDisplay || !cssRulesDrawerOpen) return;
    const frame = window.requestAnimationFrame(() => {
      sourceFileDisplay.scrollLeft = sourceFileDisplay.scrollWidth;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [cssRulesDrawerOpen, displayedStyleFile]);

  const selectedHidden = normalizeCssValue(selected?.styles?.display || "") === "none";
  const appTitle = targetTitle || DEFAULT_APP_TITLE;
  const selectedCodexModel = useMemo(
    () => codexModels.find((model) => model.model === codexModel) || codexModels.find((model) => model.isDefault) || null,
    [codexModel, codexModels]
  );
  const selectedCodexReasoningEffort = useMemo(
    () =>
      selectedCodexModel?.supportedReasoningEfforts.find((option) => option.reasoningEffort === codexReasoningEffort) ||
      selectedCodexModel?.supportedReasoningEfforts.find(
        (option) => option.reasoningEffort === selectedCodexModel.defaultReasoningEffort
      ) ||
      selectedCodexModel?.supportedReasoningEfforts[0] ||
      null,
    [codexReasoningEffort, selectedCodexModel]
  );
  const codexModelLabel = selectedCodexModel?.displayName || codexModel || "Codex default";
  const codexReasoningEffortLabel = formatReasoningEffort(selectedCodexReasoningEffort?.reasoningEffort || "");
  const codexReasoningEffortIndex = Math.max(
    0,
    selectedCodexModel?.supportedReasoningEfforts.findIndex(
      (option) => option.reasoningEffort === selectedCodexReasoningEffort?.reasoningEffort
    ) ?? 0
  );
  const codexReasoningEffortProgress = selectedCodexModel && selectedCodexModel.supportedReasoningEfforts.length > 1
    ? (codexReasoningEffortIndex / (selectedCodexModel.supportedReasoningEfforts.length - 1)) * 100
    : 0;
  const codexReasoningEffortLightness = Math.round(62 - (codexReasoningEffortProgress / 100) * 39);
  const recoverableBusyCodexThreadIds = useMemo(
    () => codexTasks
      .filter((task) => task.busy && task.threadId && !codexLastSubmitAtRef.current[task.id])
      .map((task) => task.threadId)
      .sort()
      .join(","),
    [codexTasks]
  );

  useEffect(() => {
    refreshProviderStatus();
    void refreshCodexModels();
    refreshRegisteredTarget();
    const closeEventStream = createEventStream(
      (event) => handleCodexEvent(event),
      (event) => handleWorkspaceEvent(event)
    );
    const handlePageHide = () => {
      flushPendingCodexSessionWrite();
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      closeEventStream();
      flushPendingCodexSessionWrite();
      window.cancelAnimationFrame(codexDeltaFlushFrameRef.current);
      codexDeltaFlushFrameRef.current = 0;
      codexDeltaBuffersRef.current = {};
    };
  }, []);

  useEffect(() => {
    writeCodexModelStorage(codexModel);
  }, [codexModel]);

  useEffect(() => {
    writeCodexReasoningEffortStorage(codexReasoningEffort);
  }, [codexReasoningEffort]);

  useEffect(() => {
    workspaceRootRef.current = workspaceRoot;
    agentsInstructionsRef.current = "";
    draftAgentsInstructionsRef.current = "";
    globalAgentsInstructionsRef.current = "";
    draftGlobalAgentsInstructionsRef.current = "";
    setAgentsInstructions("");
    setDraftAgentsInstructions("");
    setGlobalAgentsInstructions("");
    setDraftGlobalAgentsInstructions("");
    setAgentsInstructionsStatus(workspaceRoot ? "Loading AGENTS.md..." : "No project workspace available");
    setGlobalAgentsInstructionsStatus(workspaceRoot ? "Loading global rules..." : "Not loaded");
    if (workspaceRoot) void refreshAgentsInstructions(workspaceRoot);
  }, [workspaceRoot]);

  useEffect(() => {
    if (!agentsViewerMode) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAgentsViewerMode(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [agentsViewerMode]);

  useEffect(() => {
    const nextWorkspaceRoot = normalizeCodexWorkspaceRoot(workspaceRoot);
    if (nextWorkspaceRoot === codexSessionWorkspaceRoot) return;
    flushPendingCodexSessionWrite();
    const nextSession = readCodexSessionStorage(nextWorkspaceRoot);
    pendingCodexTaskScrollRef.current = nextSession.activeTaskId;
    replaceCodexTasks(nextSession.tasks);
    setActiveCodexTaskId(nextSession.activeTaskId);
    codexTurnBusyRef.current = {};
    codexLastSubmitAtRef.current = {};
    window.cancelAnimationFrame(codexDeltaFlushFrameRef.current);
    codexDeltaFlushFrameRef.current = 0;
    codexDeltaBuffersRef.current = {};
    setCodexSessionWorkspaceRoot(nextWorkspaceRoot);
  }, [workspaceRoot, codexSessionWorkspaceRoot]);

  useEffect(() => {
    window.clearTimeout(codexSessionWriteTimerRef.current);
    pendingCodexSessionWriteRef.current = {
      root: codexSessionWorkspaceRoot,
      snapshot: { activeTaskId: activeCodexTaskId, tasks: codexTasks }
    };
    codexSessionWriteTimerRef.current = window.setTimeout(
      flushPendingCodexSessionWrite,
      CODEX_SESSION_WRITE_DEBOUNCE_MS
    );
  }, [codexSessionWorkspaceRoot, activeCodexTaskId, codexTasks]);

  useEffect(() => {
    if (!recoverableBusyCodexThreadIds) return;
    let cancelled = false;
    let timer = 0;
    let reconciling = false;

    const reconcileBusyTurns = async () => {
      if (cancelled || reconciling || document.hidden) return;
      reconciling = true;
      try {
        const threadIds = recoverableBusyCodexThreadIds.split(",").filter(Boolean);
        await Promise.all(
          threadIds.map(async (busyThreadId) => {
            try {
              const status = await getCodexThreadStatus(busyThreadId);
              if (cancelled) return;
              const task = codexTasksRef.current.find((item) => item.threadId === busyThreadId);
              if (!task || codexLastSubmitAtRef.current[task.id]) return;
              if (status.active) {
                codexTurnBusyRef.current[task.id] = true;
                setBusy(true, task.id, status.startedAt);
                return;
              }
              codexTurnBusyRef.current[task.id] = false;
              restoreAssistantMessage(
                status.finalMessage || "Codex turn ended while the page was reloading.",
                status.durationMs,
                task.id
              );
              setBusy(false, task.id);
            } catch (error) {
              addLog("error", error instanceof Error ? error.message : String(error));
            }
          })
        );
      } finally {
        reconciling = false;
      }
    };

    const scheduleReconcile = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        await reconcileBusyTurns();
        if (!cancelled) scheduleReconcile();
      }, CODEX_RECOVERY_POLL_INTERVAL_MS);
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) void reconcileBusyTurns();
    };

    void reconcileBusyTurns();
    scheduleReconcile();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [recoverableBusyCodexThreadIds]);

  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);

  useEffect(() => {
    setPreviewUrlInput(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    const smallScreenQuery = window.matchMedia(SMALL_SCREEN_MEDIA_QUERY);
    const handleScreenSizeChange = (event: MediaQueryListEvent) => {
      if (event.matches) setCssRulesDrawerOpen(false);
    };

    smallScreenQuery.addEventListener("change", handleScreenSizeChange);
    return () => smallScreenQuery.removeEventListener("change", handleScreenSizeChange);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data || {};
      if (message.source !== "web-no-code-inspector") return;
      if (message.type === "ready") {
        setTargetTitle(normalizeTargetTitle(message.payload?.title));
        if (message.payload?.url) {
          const nextUrl = withEditorPassthroughParams(message.payload.url);
          setTargetUrl(nextUrl);
          setLoadedUrl(nextUrl);
          setPreviewUrl(nextUrl);
        }
        if (message.payload?.root) {
          setWorkspaceRoot(message.payload.root);
        }
        setTargetAliases(normalizeTargetAliases(message.payload?.aliases));
        postInspectorState();
        addLog("status", `Inspector connected: ${message.payload?.url || loadedUrl}`);
      }
      if (message.type === "title-change") {
        setTargetTitle(normalizeTargetTitle(message.payload?.title));
      }
      if (message.type === "url-change" && message.payload?.url) {
        setPreviewUrl(message.payload.url);
      }
      if (message.type === "selected") {
        if (message.payload?.selector) {
          setSelected(message.payload);
          setSelectedElements((current) => current.length ? current : [message.payload]);
          setCodexElementEnabled(true);
          setCodexElementVisible(true);
          setStyleFile(resolveRuleStyleFile(message.payload, styleProperty));
        } else {
          setSelected(null);
        }
      }
      if (message.type === "selected-elements") {
        const elements = Array.isArray(message.payload?.elements)
          ? message.payload.elements.filter((element: SelectedElementContext) => Boolean(element?.selector))
          : [];
        setSelectedElements(elements);
        if (elements.length) {
          setCodexElementEnabled(true);
          setCodexElementVisible(true);
        }
      }
      if (message.type === "sibling-options") {
        const requestId = Number(message.payload?.requestId);
        setSiblingPicker((current) => {
          if (!current || current.requestId !== requestId) return current;
          return {
            ...current,
            currentSelector: String(message.payload?.currentSelector || current.currentSelector),
            loading: false,
            options: normalizeSiblingOptions(message.payload?.options)
          };
        });
      }
      if (message.type === "clipboard-images") {
        void handleInspectorClipboardImages(message.payload?.images || []);
      }
      if (message.type === "style-position-commit") {
        void handleStylePositionCommit(message.payload);
      }
      if (message.type === "shortcut") {
        handleInspectorShortcutMessage(message.payload?.shortcut);
      }
      if (message.type === "temporary-inspector") {
        setTemporaryInspectorMode(message.payload?.active ? normalizeTemporaryInspectorMode(message.payload?.mode) : null);
      }
      if (message.type === "status" && message.payload?.message) {
        addLog("status", message.payload.message);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [loadedUrl]);

  useEffect(() => {
    postInspectorState();
  }, [inspectorEnabled, temporaryInspectorMode, dragEnabled, loadedUrl]);

  useEffect(() => {
    if (!selected) return;
    const property = firstEditableStyleProperty(selected) || "background-color";
    setStyleProperty(property);
    setStyleValue(normalizeCssValue(selected.styles?.[property] || "#ffbf47"));
    setStyleFile(resolveRuleStyleFile(selected, property));
  }, [selected]);

  useEffect(() => {
    addCodexAttachmentsRef.current = addCodexAttachments;
    codexAttachmentsRef.current = codexAttachments;
    codexTasksRef.current = codexTasks;
    activeCodexTaskIdRef.current = activeCodexTaskId;
  });

  useEffect(() => {
    const panel = chatPanelRef.current;
    if (!panel) return;
    panel.scrollTop = panel.scrollHeight;
  }, [chatMessages, busy]);

  useEffect(() => {
    if (!busy || !activeCodexTask?.id) return;
    if (!activeCodexTask.turnStartedAt) setBusy(true, activeCodexTask.id);
    setCodexActivityNow(Date.now());
    const timer = window.setInterval(() => setCodexActivityNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy, activeCodexTask?.id, activeCodexTask?.turnStartedAt]);

  useEffect(() => {
    const taskId = pendingCodexTaskScrollRef.current;
    if (!taskId) return;
    const frame = window.requestAnimationFrame(() => {
      const list = codexTaskListRef.current;
      const tab = codexTaskTabRefs.current.get(taskId);
      if (!list || !tab) return;
      pendingCodexTaskScrollRef.current = "";
      const listBounds = list.getBoundingClientRect();
      const tabBounds = tab.getBoundingClientRect();
      if (tabBounds.right > listBounds.right) {
        list.scrollBy({ left: tabBounds.right - listBounds.right + 2, behavior: "smooth" });
      } else if (tabBounds.left < listBounds.left) {
        list.scrollBy({ left: tabBounds.left - listBounds.left - 2, behavior: "smooth" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [codexTasks.length, activeCodexTaskId]);

  function updateCodexTask(taskId: string, updater: (task: CodexTask) => CodexTask) {
    replaceCodexTasks((current) => {
      const next = current.map((task) => (task.id === taskId ? { ...updater(task), updatedAt: Date.now() } : task));
      return next;
    });
  }

  function replaceCodexTasks(value: SetStateAction<CodexTask[]>) {
    setCodexTasks((current) => {
      const next = typeof value === "function" ? value(current) : value;
      codexTasksRef.current = next;
      return next;
    });
  }

  function flushPendingCodexSessionWrite() {
    window.clearTimeout(codexSessionWriteTimerRef.current);
    codexSessionWriteTimerRef.current = 0;
    const pending = pendingCodexSessionWriteRef.current;
    pendingCodexSessionWriteRef.current = null;
    if (pending) writeCodexSessionStorage(pending.root, pending.snapshot);
  }

  function updateActiveCodexTask(updater: (task: CodexTask) => CodexTask) {
    if (!activeCodexTask) return;
    updateCodexTask(activeCodexTask.id, updater);
  }

  function setCodexInput(value: SetStateAction<string>) {
    updateActiveCodexTask((task) => ({
      ...task,
      input: typeof value === "function" ? value(task.input) : value
    }));
  }

  function setCodexAttachments(value: SetStateAction<CodexAttachment[]>) {
    updateActiveCodexTask((task) => ({
      ...task,
      attachments: typeof value === "function" ? value(task.attachments) : value
    }));
  }

  function setBusy(value: boolean, taskId = activeCodexTask?.id, startedAt?: number) {
    if (!taskId) return;
    updateCodexTask(taskId, (task) => ({
      ...task,
      busy: value,
      turnStartedAt: value ? startedAt || task.turnStartedAt || Date.now() : undefined
    }));
  }

  useEffect(() => {
    const breadcrumb = selectorBreadcrumbRef.current;
    if (!breadcrumb) return;
    const frame = requestAnimationFrame(() => {
      breadcrumb.scrollLeft = breadcrumb.scrollWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.selector]);

  useEffect(() => {
    if (!codexElementVisible || !selected?.selector) return;
    const frame = requestAnimationFrame(() => {
      const list = codexContextListRef.current;
      const activeChip = list?.querySelector<HTMLElement>("[data-codex-context-active='true']");
      if (!list || !activeChip) return;
      const listBounds = list.getBoundingClientRect();
      const chipBounds = activeChip.getBoundingClientRect();
      if (chipBounds.right > listBounds.right) {
        list.scrollBy({ left: chipBounds.right - listBounds.right + 2, behavior: "smooth" });
      } else if (chipBounds.left < listBounds.left) {
        list.scrollBy({ left: chipBounds.left - listBounds.left - 2, behavior: "smooth" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.selector, selectedElements.length, codexElementVisible]);

  useEffect(() => {
    if (!siblingPicker) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!siblingPickerRef.current?.contains(event.target as Node)) setSiblingPicker(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSiblingPicker(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [siblingPicker]);

  useEffect(() => {
    let blurTimer = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && codexModelPickerOpen) {
        event.preventDefault();
        setCodexModelPickerOpen(false);
        return;
      }
      if (event.key === "Escape" && codexSettingsOpen) {
        event.preventDefault();
        setCodexSettingsOpen(false);
        return;
      }
      if (event.key === "Escape" && previewQueryEditor.open) {
        event.preventDefault();
        closePreviewQueryEditor();
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (isInspectorShortcut(event)) {
        event.preventDefault();
        toggleInspectorMode();
        return;
      }
      if (isDragShortcut(event)) {
        event.preventDefault();
        toggleDragMode();
        return;
      }
      if ((sourceLocation || workspaceRoot) && isOpenSourceShortcut(event)) {
        event.preventDefault();
        handleOpenSource();
        return;
      }
      const temporaryMode = temporaryInspectorModeFromEvent(event);
      if (temporaryMode && !inspectorEnabled && !dragEnabled) {
        setTemporaryInspectorMode(temporaryMode);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const temporaryMode = temporaryInspectorModeFromKey(event.key);
      if (temporaryMode) {
        setTemporaryInspectorMode((current) => (current === temporaryMode ? null : current));
      }
    };
    const onBlur = () => {
      window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(() => {
        if (!document.hasFocus()) setTemporaryInspectorMode(null);
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.clearTimeout(blurTimer);
    };
  }, [codexModelPickerOpen, codexSettingsOpen, dragEnabled, inspectorEnabled, previewQueryEditor.open, sourceLocation, workspaceRoot]);

  useEffect(() => {
    if (!codexModelPickerOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!codexModelPickerRef.current?.contains(event.target as Node)) {
        setCodexModelPickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [codexModelPickerOpen]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (!isCodexPasteTarget(event.target) && leftView !== "codex") return;
      const files = event.clipboardData ? imageFilesFromClipboard(event.clipboardData) : [];
      if (!files.length) {
        void addImagesFromAsyncClipboard("paste fallback");
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      lastPasteHandledAtRef.current = Date.now();
      void addCodexAttachmentsRef.current(files);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCodexPasteTarget(event.target) && leftView !== "codex") return;
      if (!((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v")) return;
      window.setTimeout(() => {
        if (Date.now() - lastPasteHandledAtRef.current < 700) return;
        void addImagesFromAsyncClipboard("Cmd+V fallback");
      }, 0);
    };
    const onBeforeInput = (event: InputEvent) => {
      if (!isCodexPasteTarget(event.target) && leftView !== "codex") return;
      if (event.inputType !== "insertFromPaste") return;
      const files = event.dataTransfer ? imageFilesFromClipboard(event.dataTransfer) : [];
      if (!files.length) return;
      event.preventDefault();
      lastPasteHandledAtRef.current = Date.now();
      void addCodexAttachmentsRef.current(files);
    };
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("beforeinput", onBeforeInput, true);
    return () => {
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("beforeinput", onBeforeInput, true);
    };
  }, [leftView]);

  async function refreshProviderStatus() {
    try {
      const status = await getCodexStatus("app-server");
      setProviderName(status.provider);
      setProviderStatus(status.available ? status.codexVersion || status.reason || "available" : status.reason);
    } catch (error) {
      setProviderName("unavailable");
      setProviderStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshCodexModels() {
    setCodexModelsLoading(true);
    try {
      const result = await getCodexModels("app-server");
      setCodexModels(result.models);
      setCodexModel((current) => (current && !result.models.some((model) => model.model === current) ? "" : current));
      const activeModel = result.models.find((model) => model.model === codexModel) || result.models.find((model) => model.isDefault);
      setCodexReasoningEffort((current) =>
        current && !activeModel?.supportedReasoningEfforts.some((option) => option.reasoningEffort === current) ? "" : current
      );
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    } finally {
      setCodexModelsLoading(false);
    }
  }

  async function ensureSkillsLoaded() {
    if (skills.length) return;
    try {
      const result = await getCodexSkills();
      setSkills(result.skills);
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshRegisteredTarget() {
    try {
      const storedRoot = editorTargetRootRef.current;
      const result = await getRegisteredTargets(storedRoot);
      const target = selectRegisteredTarget(result.targets, storedRoot);
      if (!target) return;
      if (!storedRoot) {
        editorTargetRootRef.current = target.root;
        writeEditorTargetRootStorage(target.root);
      }
      const nextUrl = withEditorPassthroughParams(target.url);
      setTargetUrl(nextUrl);
      setLoadedUrl(nextUrl);
      setTargetTitle("");
      setWorkspaceRoot(target.root);
      setTargetAliases(normalizeTargetAliases(target.aliases));
      if (target.width) setEditorDeviceWidth(target.width);
      addLog("status", `Target detected: ${nextUrl}`);
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    }
  }

  function handleCodexEvent(event: CodexEvent) {
    const tasks = codexTasksRef.current;
    const activeTaskId = activeCodexTaskIdRef.current;
    const eventThreadId = "threadId" in event ? event.threadId : "";
    const eventTask = eventThreadId
      ? tasks.find((task) => task.threadId === eventThreadId || task.id === codexThreadTaskIdsRef.current[eventThreadId])
      : tasks.find((task) => task.id === activeTaskId) || tasks[0];
    const eventTaskId = eventTask?.id;
    if (event.type === "delta" && event.text) {
      queueAssistantDelta(event.text, eventTaskId);
    }
    if (event.type === "status" || event.type === "provider") {
      addLog("status", event.message);
    }
    if (event.type === "error") {
      addLog("error", event.message);
    }
    if (event.type === "completed") {
      flushAssistantDeltas();
      if (event.finalMessage) {
        addLog("assistant", event.finalMessage);
      }
      settleAssistantMessage(event.finalMessage, event.durationMs, eventTaskId);
      if (eventTaskId) {
        codexTurnBusyRef.current[eventTaskId] = false;
        setBusy(false, eventTaskId);
      }
    }
  }

  function handleWorkspaceEvent(event: WorkspaceAgentsEvent) {
    if (event.type !== "agents-updated") return;
    if (normalizeCodexWorkspaceRoot(event.root) !== normalizeCodexWorkspaceRoot(workspaceRootRef.current)) return;
    const hasLocalChanges = draftAgentsInstructionsRef.current !== agentsInstructionsRef.current;
    agentsInstructionsRef.current = event.content;
    setAgentsInstructions(event.content);
    if (!hasLocalChanges || draftAgentsInstructionsRef.current === event.content) {
      draftAgentsInstructionsRef.current = event.content;
      setDraftAgentsInstructions(event.content);
      setAgentsInstructionsStatus(event.exists ? "Up to date" : "File not created");
    }
  }

  function postInspectorState() {
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: "web-no-code-editor",
        type: "inspector:set-enabled",
        enabled: inspectorEnabled || dragEnabled,
        dragEnabled,
        temporaryMode: temporaryInspectorMode
      },
      "*"
    );
  }

  function toggleInspectorMode() {
    setInspectorEnabled((enabled) => {
      const nextEnabled = !enabled;
      setTemporaryInspectorMode(null);
      if (nextEnabled) setDragEnabled(false);
      if (!nextEnabled) clearSelectedElement();
      return nextEnabled;
    });
  }

  function toggleDragMode() {
    setDragEnabled((enabled) => {
      const nextEnabled = !enabled;
      setTemporaryInspectorMode(null);
      if (nextEnabled) setInspectorEnabled(false);
      return nextEnabled;
    });
  }

  function handleInspectorShortcutMessage(shortcut: unknown) {
    if (shortcut === "select") {
      toggleInspectorMode();
      return;
    }
    if (shortcut === "drag") {
      toggleDragMode();
      return;
    }
    if (shortcut === "open-source") {
      openSourceRef.current();
    }
  }

  function previewStyleValue(property: string, value: string) {
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: "web-no-code-editor",
        type: "inspector:style-preview",
        property,
        value,
        selector: selected?.selector
      },
      "*"
    );
  }

  function selectElementBySelector(selector: string) {
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: "web-no-code-editor",
        type: "inspector:select-element",
        selector
      },
      "*"
    );
  }

  function openSiblingPicker(
    event: React.MouseEvent<HTMLButtonElement>,
    selector: string,
    parentLabel: string
  ) {
    event.stopPropagation();
    const requestId = siblingPickerRequestIdRef.current + 1;
    siblingPickerRequestIdRef.current = requestId;
    const bounds = event.currentTarget.getBoundingClientRect();
    const menuWidth = 280;
    setSiblingPicker({
      requestId,
      currentSelector: selector,
      parentLabel,
      left: Math.max(8, Math.min(bounds.left, window.innerWidth - menuWidth - 8)),
      top: bounds.bottom + 6,
      loading: true,
      options: []
    });
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: "web-no-code-editor",
        type: "inspector:list-siblings",
        selector,
        requestId
      },
      "*"
    );
  }

  function selectSibling(selector: string) {
    setSiblingPicker(null);
    selectElementBySelector(selector);
  }

  function clearSelectedElement() {
    setFocusedStyleProperty("");
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: "web-no-code-editor",
        type: "inspector:clear-selected"
      },
      "*"
    );
  }

  function removeSelectedElement(selector: string, selectionIndex: number) {
    setSelectedElements((current) => current.filter((_, index) => index !== selectionIndex));
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: "web-no-code-editor",
        type: "inspector:remove-selected",
        selector,
        selectionIndex
      },
      "*"
    );
  }

  function reloadTarget(cacheBust = false) {
    const nextUrl = withEditorPassthroughParams(targetUrl, cacheBust);
    setTargetUrl(nextUrl);
    setLoadedUrl(nextUrl);
    setPreviewUrl(nextUrl);
    setTargetTitle("");
    try {
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      iframeRef.current?.setAttribute("src", nextUrl);
    }
    setTimeout(postInspectorState, 300);
  }

  function navigatePreviewUrl(value = previewUrlInput) {
    const resolvedUrl = resolvePreviewNavigationUrl(value, previewUrl);
    if (!resolvedUrl) {
      setPreviewUrlInput(previewUrl);
      return;
    }
    const nextUrl = withEditorPassthroughParams(resolvedUrl);
    setTargetUrl(nextUrl);
    setPreviewUrl(nextUrl);
    setTargetTitle("");
    if (nextUrl === loadedUrl) {
      iframeRef.current?.setAttribute("src", nextUrl);
    } else {
      setLoadedUrl(nextUrl);
    }
    setTimeout(postInspectorState, 300);
  }

  function openPreviewQueryEditor() {
    try {
      const url = new URL(resolvePreviewNavigationUrl(previewUrlInput, previewUrl), window.location.href);
      setPreviewQueryEditor({
        open: true,
        params: Array.from(url.searchParams.entries(), ([key, value]) => createPreviewQueryParam(key, value)),
        error: ""
      });
    } catch {
      setPreviewQueryEditor({ open: true, params: [], error: "Enter a valid URL before editing its parameters." });
    }
  }

  function closePreviewQueryEditor() {
    setPreviewQueryEditor((current) => ({ ...current, open: false, error: "" }));
  }

  function updatePreviewQueryParam(id: string, field: "key" | "value", value: string) {
    setPreviewQueryEditor((current) => ({
      ...current,
      error: "",
      params: current.params.map((param) => (param.id === id ? { ...param, [field]: value } : param))
    }));
  }

  function addPreviewQueryParam() {
    setPreviewQueryEditor((current) => ({
      ...current,
      error: "",
      params: [...current.params, createPreviewQueryParam()]
    }));
  }

  function removePreviewQueryParam(id: string) {
    setPreviewQueryEditor((current) => ({
      ...current,
      params: current.params.filter((param) => param.id !== id)
    }));
  }

  function applyPreviewQueryParams(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const url = new URL(resolvePreviewNavigationUrl(previewUrlInput, previewUrl), window.location.href);
      url.search = "";
      for (const param of previewQueryEditor.params) {
        const key = param.key.trim();
        if (key) url.searchParams.append(key, param.value);
      }
      closePreviewQueryEditor();
      navigatePreviewUrl(url.href);
    } catch {
      setPreviewQueryEditor((current) => ({ ...current, error: "Unable to apply parameters to this URL." }));
    }
  }

  function refreshPreview() {
    const nextUrl = previewUrl || loadedUrl;
    iframeRef.current?.setAttribute("src", nextUrl);
    setTimeout(postInspectorState, 300);
  }

  function handleDeviceWidthChange(width: DeviceWidth) {
    setEditorDeviceWidth(width);
  }

  function setEditorDeviceWidth(width: DeviceWidth) {
    setDeviceWidth(width);
    const url = new URL(window.location.href);
    url.searchParams.set("width", String(width));
    window.history.replaceState(null, "", url);
  }

  function handleCodexInputChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    const cursor = event.target.selectionStart;
    setCodexInput(value);
    updateSkillMenu(value, cursor);
  }

  async function handleCodexInputPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (!files.length) {
      void addImagesFromAsyncClipboard("react paste fallback");
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    lastPasteHandledAtRef.current = Date.now();
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText && event.target instanceof HTMLTextAreaElement) {
      insertCodexInputText(event.target, pastedText);
    }

    await addCodexAttachments(files);
  }

  function handleCodexAttachmentInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith("image/"));
    event.target.value = "";
    if (!files.length) return;
    void addCodexAttachments(files);
  }

  function handleCodexDrop(event: ReactDragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files || []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void addCodexAttachments(files);
  }

  function handleCodexDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (Array.from(event.dataTransfer.items || []).some((item) => item.type.startsWith("image/"))) {
      event.preventDefault();
    }
  }

  async function handleInspectorClipboardImages(images: Array<{ name?: string; type?: string; dataUrl?: string }>) {
    const files = images
      .map((image, index) => fileFromDataUrl(image.dataUrl || "", image.name || `pasted-image-${index}.png`, image.type || "image/png"))
      .filter((file): file is File => Boolean(file));
    if (!files.length) {
      setCodexPasteStatus("iframe paste: no readable image");
      return;
    }
    lastPasteHandledAtRef.current = Date.now();
    await addCodexAttachments(files);
  }

  function insertCodexInputText(target: HTMLTextAreaElement, text: string) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const nextValue = `${codexInput.slice(0, start)}${text}${codexInput.slice(end)}`;
    const nextCursor = start + text.length;
    setCodexInput(nextValue);
    updateSkillMenu(nextValue, nextCursor);
    requestAnimationFrame(() => {
      target.selectionStart = nextCursor;
      target.selectionEnd = nextCursor;
    });
  }

  async function addCodexAttachments(files: File[]) {
    if (!files.length) return;
    let imageInputs: Array<{ file: File; dataUrl: string; signature: string }> = [];
    try {
      imageInputs = await Promise.all(
        files.map(async (file) => {
          const dataUrl = await fileToDataUrl(file);
          return {
            file,
            dataUrl,
            signature: imageSignature(dataUrl)
          };
        })
      );
      const seen = new Set(codexAttachmentsRef.current.map((attachment) => attachment.signature));
      const uniqueInputs = imageInputs.filter((input) => {
        if (pendingAttachmentSignaturesRef.current.has(input.signature)) return false;
        if (seen.has(input.signature)) return false;
        seen.add(input.signature);
        pendingAttachmentSignaturesRef.current.add(input.signature);
        return true;
      });
      if (!uniqueInputs.length) {
        addLog("status", "Image already attached for Codex");
        return;
      }
      const nextAttachments = await Promise.all(
        uniqueInputs.map(async ({ file, dataUrl, signature }) => {
          const result = await uploadCodexAttachment(file);
          return {
            id: createClientId(),
            name: result.attachment.name || file.name || "pasted-image",
            path: result.attachment.path,
            previewUrl: dataUrl,
            signature
          };
        })
      );
      const added = nextAttachments.length;
      setCodexAttachments((current) => [...current, ...nextAttachments]);
      addLog("status", added ? `Attached ${added} image${added === 1 ? "" : "s"} for Codex` : "Image already attached for Codex");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = message.includes("Expected JSON from /api/codex/attachments")
        ? "attach failed: restart web-no-code server to enable temporary image uploads"
        : `attach failed: ${message}`;
      for (const input of imageInputs || []) {
        pendingAttachmentSignaturesRef.current.delete(input.signature);
      }
      setCodexPasteStatus(hint);
      addLog("error", message);
    }
  }

  async function addImagesFromAsyncClipboard(reason: string) {
    try {
      const files = await imageFilesFromAsyncClipboard();
      if (!files.length) {
        return;
      }
      await addCodexAttachmentsRef.current(files);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCodexPasteStatus(`${reason}: ${message}`);
      addLog("error", message);
    }
  }

  function removeCodexAttachment(id: string) {
    setCodexAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) pendingAttachmentSignaturesRef.current.delete(removed.signature);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function clearCodexAttachments(attachments = codexAttachments) {
    for (const attachment of attachments) {
      pendingAttachmentSignaturesRef.current.delete(attachment.signature);
    }
    setCodexAttachments([]);
  }

  function restoreCodexComposer(taskId: string, input: string, attachments: CodexAttachment[]) {
    for (const attachment of attachments) {
      pendingAttachmentSignaturesRef.current.add(attachment.signature);
    }
    updateCodexTask(taskId, (task) => {
      const restoredInput = task.input.trim() ? `${input.trim()}\n${task.input}` : input;
      const existingAttachmentIds = new Set(task.attachments.map((attachment) => attachment.id));
      return {
        ...task,
        input: restoredInput,
        attachments: [...attachments.filter((attachment) => !existingAttachmentIds.has(attachment.id)), ...task.attachments]
      };
    });
  }

  function createCodexTask() {
    if (codexTasksRef.current.length >= MAX_CODEX_TASKS) return;
    const task = createEmptyCodexTask();
    pendingCodexTaskScrollRef.current = task.id;
    replaceCodexTasks((current) => {
      if (current.length >= MAX_CODEX_TASKS) return current;
      const next = [...current, task];
      return next;
    });
    setActiveCodexTaskId(task.id);
    activeCodexTaskIdRef.current = task.id;
    setPendingDeleteCodexTaskId("");
    closeSkillMenu();
    addLog("status", "Started a new Codex task");
  }

  function switchCodexTask(taskId: string) {
    setActiveCodexTaskId(taskId);
    activeCodexTaskIdRef.current = taskId;
    setPendingDeleteCodexTaskId("");
    closeSkillMenu();
    window.requestAnimationFrame(() => centerCodexTaskTab(taskId));
  }

  function centerCodexTaskTab(taskId: string) {
    const list = codexTaskListRef.current;
    const tab = codexTaskTabRefs.current.get(taskId);
    if (!list || !tab) return;
    const listBounds = list.getBoundingClientRect();
    const tabBounds = tab.getBoundingClientRect();
    const offset = tabBounds.left + tabBounds.width / 2 - (listBounds.left + listBounds.width / 2);
    list.scrollBy({ left: offset, behavior: "smooth" });
  }

  function deleteCodexTask(taskId: string) {
    setPendingDeleteCodexTaskId(taskId);
  }

  function confirmDeleteCodexTask(taskId: string) {
    const currentTasks = codexTasksRef.current;
    const taskIndex = currentTasks.findIndex((task) => task.id === taskId);
    if (taskIndex < 0) return;
    const task = currentTasks[taskIndex];
    if (task.threadId && task.busy) {
      void interruptCodexTurn(task.threadId).catch((error) => {
        addLog("error", error instanceof Error ? error.message : String(error));
      });
    }
    delete codexTurnBusyRef.current[taskId];
    delete codexLastSubmitAtRef.current[taskId];
    if (task.threadId) delete codexThreadTaskIdsRef.current[task.threadId];
    const remainingTasks = currentTasks.filter((item) => item.id !== taskId);
    const nextTasks = remainingTasks.length ? remainingTasks : [createEmptyCodexTask()];
    const nextActiveTask =
      taskId === activeCodexTaskIdRef.current
        ? nextTasks[Math.min(taskIndex, nextTasks.length - 1)]
        : nextTasks.find((item) => item.id === activeCodexTaskIdRef.current) || nextTasks[0];
    replaceCodexTasks(nextTasks);
    setActiveCodexTaskId(nextActiveTask.id);
    activeCodexTaskIdRef.current = nextActiveTask.id;
    setPendingDeleteCodexTaskId("");
    closeSkillMenu();
  }

  function renameCodexTaskFromInput(taskId: string, input: string) {
    const title = summarizeCodexTaskTitle(input);
    if (!title) return;
    updateCodexTask(taskId, (task) => (task.title === "New task" ? { ...task, title } : task));
  }

  function handleCodexInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (skillMenuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSkillMenu();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSkillActiveIndex(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const skill = filteredSkills[skillActiveIndex] || filteredSkills[0];
        if (!skill) return;
        event.preventDefault();
        insertSkill(skill.name);
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
      window.setTimeout(() => {
        if (Date.now() - lastPasteHandledAtRef.current < 700) return;
        void addImagesFromAsyncClipboard("textarea Cmd+V fallback");
      }, 0);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleRunCodex();
    }
  }

  function updateSkillMenu(value: string, cursor: number) {
    const beforeCursor = value.slice(0, cursor);
    const dollarIndex = beforeCursor.lastIndexOf("$");
    if (dollarIndex < 0) {
      closeSkillMenu();
      return;
    }
    const query = beforeCursor.slice(dollarIndex + 1);
    if (!/^[A-Za-z0-9_-]*$/.test(query)) {
      closeSkillMenu();
      return;
    }
    setSkillTriggerStart(dollarIndex);
    setSkillQuery(query);
    setSkillActiveIndex(0);
    setSkillMenuOpen(true);
    void ensureSkillsLoaded();
  }

  function insertSkill(name: string) {
    if (skillTriggerStart == null) return;
    const before = codexInput.slice(0, skillTriggerStart);
    const after = codexInput.slice(skillTriggerStart + skillQuery.length + 1);
    setCodexInput(`${before}$${name} ${after}`);
    closeSkillMenu();
  }

  function closeSkillMenu() {
    setSkillMenuOpen(false);
    setSkillQuery("");
    setSkillTriggerStart(null);
    setSkillActiveIndex(0);
  }

  function toggleCodexModelPicker() {
    const nextOpen = !codexModelPickerOpen;
    setCodexModelPickerOpen(nextOpen);
    if (!nextOpen) return;
    closeSkillMenu();
    setCodexSettingsOpen(false);
    if (!codexModels.length) void refreshCodexModels();
  }

  function openCodexSettings() {
    setDraftCodexSandbox(codexSandbox);
    setDraftCodexWorkspaceMode(codexWorkspaceMode);
    draftAgentsInstructionsRef.current = agentsInstructionsRef.current;
    setDraftAgentsInstructions(agentsInstructionsRef.current);
    draftGlobalAgentsInstructionsRef.current = globalAgentsInstructionsRef.current;
    setDraftGlobalAgentsInstructions(globalAgentsInstructionsRef.current);
    setCodexModelPickerOpen(false);
    setAgentsViewerMode(null);
    closeSkillMenu();
    setCodexSettingsOpen(true);
    if (workspaceRoot) void refreshAgentsInstructions(workspaceRoot);
  }

  async function saveCodexSettings() {
    if (codexSettingsSaving) return;
    setCodexSettingsSaving(true);
    let saving: "project" | "global" | "settings" = "project";
    try {
      if (draftAgentsInstructionsRef.current !== agentsInstructionsRef.current) {
        if (!workspaceRoot) throw new Error("No project workspace available");
        setAgentsInstructionsStatus("Saving...");
        const result = await updateWorkspaceAgents(workspaceRoot, draftAgentsInstructionsRef.current);
        if (normalizeCodexWorkspaceRoot(workspaceRoot) !== normalizeCodexWorkspaceRoot(workspaceRootRef.current)) return;
        agentsInstructionsRef.current = result.content;
        setAgentsInstructions(result.content);
        setAgentsInstructionsStatus("Saved");
      }

      saving = "global";
      if (draftGlobalAgentsInstructionsRef.current !== globalAgentsInstructionsRef.current) {
        setGlobalAgentsInstructionsStatus("Saving...");
        const result = await updateGlobalAgents(draftGlobalAgentsInstructionsRef.current);
        globalAgentsInstructionsRef.current = result.content;
        setGlobalAgentsInstructions(result.content);
        setGlobalAgentsInstructionsStatus("Saved");
      }

      saving = "settings";
      setCodexSandbox(draftCodexSandbox);
      setCodexWorkspaceMode(draftCodexWorkspaceMode);
      writeCodexSandboxStorage(draftCodexSandbox);
      writeCodexWorkspaceModeStorage(draftCodexWorkspaceMode);
    } catch (error) {
      const message = formatAgentsApiError(error);
      if (saving === "project") setAgentsInstructionsStatus(message);
      if (saving === "global") setGlobalAgentsInstructionsStatus(message);
    } finally {
      setCodexSettingsSaving(false);
    }
  }

  function closeCodexSettings() {
    draftAgentsInstructionsRef.current = agentsInstructionsRef.current;
    setDraftAgentsInstructions(agentsInstructionsRef.current);
    draftGlobalAgentsInstructionsRef.current = globalAgentsInstructionsRef.current;
    setDraftGlobalAgentsInstructions(globalAgentsInstructionsRef.current);
    setDraftCodexSandbox(codexSandbox);
    setDraftCodexWorkspaceMode(codexWorkspaceMode);
    setAgentsViewerMode(null);
    setCodexSettingsOpen(false);
  }

  async function refreshAgentsInstructions(root: string) {
    if (!root) return;
    setAgentsInstructionsStatus("Loading AGENTS.md...");
    try {
      const result = await getWorkspaceAgents(root);
      if (normalizeCodexWorkspaceRoot(root) !== normalizeCodexWorkspaceRoot(workspaceRootRef.current)) return;
      const hasLocalChanges = draftAgentsInstructionsRef.current !== agentsInstructionsRef.current;
      agentsInstructionsRef.current = result.content;
      setAgentsInstructions(result.content);
      if (!hasLocalChanges) {
        draftAgentsInstructionsRef.current = result.content;
        setDraftAgentsInstructions(result.content);
      }
      const hasGlobalLocalChanges = draftGlobalAgentsInstructionsRef.current !== globalAgentsInstructionsRef.current;
      globalAgentsInstructionsRef.current = result.global.content;
      setGlobalAgentsInstructions(result.global.content);
      if (!hasGlobalLocalChanges) {
        draftGlobalAgentsInstructionsRef.current = result.global.content;
        setDraftGlobalAgentsInstructions(result.global.content);
      }
      setGlobalAgentsInstructionsStatus(result.global.exists ? "Up to date" : "File will be created on save");
      setAgentsInstructionsStatus(result.exists ? "Up to date" : "File will be created on save");
    } catch (error) {
      const message = formatAgentsApiError(error);
      setAgentsInstructionsStatus(message);
      setGlobalAgentsInstructionsStatus(message);
    }
  }

  function handleAgentsInstructionsChange(value: string) {
    draftAgentsInstructionsRef.current = value;
    setDraftAgentsInstructions(value);
    if (!workspaceRoot) {
      setAgentsInstructionsStatus("No project workspace available");
      return;
    }
    setAgentsInstructionsStatus(value === agentsInstructionsRef.current ? "Up to date" : "Unsaved changes");
  }

  function handleGlobalAgentsInstructionsChange(value: string) {
    draftGlobalAgentsInstructionsRef.current = value;
    setDraftGlobalAgentsInstructions(value);
    setGlobalAgentsInstructionsStatus(value === globalAgentsInstructionsRef.current ? "Up to date" : "Unsaved changes");
  }

  function selectCodexModel(model: CodexModel) {
    setCodexModel(model.model);
    setCodexReasoningEffort((current) =>
      current && !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === current) ? "" : current
    );
    setCodexModelPickerOpen(false);
    addLog("status", `Codex model set to ${model.displayName}`);
  }

  function selectCodexReasoningEffort(effort: string) {
    setCodexReasoningEffort(effort);
    addLog("status", `Codex reasoning effort set to ${formatReasoningEffort(effort)}`);
  }

  function handleCodexReasoningEffortChange(event: ChangeEvent<HTMLInputElement>) {
    const option = selectedCodexModel?.supportedReasoningEfforts[Number(event.target.value)];
    if (!option || option.reasoningEffort === selectedCodexReasoningEffort?.reasoningEffort) return;
    selectCodexReasoningEffort(option.reasoningEffort);
  }

  function moveSkillActiveIndex(delta: 1 | -1) {
    setSkillActiveIndex((current) => {
      if (!filteredSkills.length) return 0;
      return (current + delta + filteredSkills.length) % filteredSkills.length;
    });
  }

  async function commitStyleToSource(property = styleProperty, value = styleValue) {
    if (!selected?.selector) return false;
    if (!hasStyleValueChanged(property, value)) return false;
    const propertySource = selected.styleSources?.[property];
    if (propertySource && !propertySource.file) {
      addLog("error", "No editable source file available for the selected style");
      return false;
    }
    const file = resolveRuleStyleFile(selected, property) || styleFile;
    if (!file) {
      addLog("error", "No editable source file available for the selected style");
      return false;
    }
    const selectors = selectorCandidates(selected);
    const source = resolveStyleSource(selected, property);
    try {
      await applyStylePatch({
        root: workspaceRoot,
        file,
        selector: selectors[0],
        selectors,
        property,
        value,
        line: source?.line,
        column: source?.column
      });
      setStyleFile(file);
      setSelected((current) => updateSelectedStyle(current, property, value, file, source));
      addLog("status", `Applied ${property} to ${file}`);
      return true;
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function handleStylePositionCommit(payload: {
    selector?: string;
    left?: string;
    top?: string;
    context?: SelectedElementContext;
  }) {
    const context = payload.context || selected;
    if (!context?.selector) return;
    const file = resolvePositionStyleFile(context, "left") || resolvePositionStyleFile(context, "top") || styleFile;
    if (!file) {
      addLog("error", "No editable source file available for the dragged element");
      return;
    }
    const leftSelectors = selectorCandidates(context, "left");
    const topSelectors = selectorCandidates(context, "top");
    try {
      await applyStylePatch({
        root: workspaceRoot,
        file,
        selector: leftSelectors[0] || payload.selector || context.selector,
        selectors: leftSelectors,
        property: "left",
        value: payload.left || "0px",
        line: resolveStyleSource(context, "left")?.line,
        column: resolveStyleSource(context, "left")?.column
      });
      await applyStylePatch({
        root: workspaceRoot,
        file,
        selector: topSelectors[0] || payload.selector || context.selector,
        selectors: topSelectors,
        property: "top",
        value: payload.top || "0px",
        line: resolveStyleSource(context, "top")?.line,
        column: resolveStyleSource(context, "top")?.column
      });
      setSelected(context);
      setCodexElementEnabled(true);
      setCodexElementVisible(true);
      setStyleFile(file);
      addLog("status", `Applied dragged position to ${file}`);
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    }
  }

  function handleStyleValueChange(property: string, value: string) {
    setStyleProperty(property);
    setStyleValue(value);
    updateStyleFileForProperty(property);
    previewStyleValue(property, value);
  }

  function handleHideSelectedElement() {
    if (!selected?.selector) return;
    setStyleProperty("display");
    setStyleValue("none");
    updateStyleFileForProperty("display");
    previewStyleValue("display", "none");
    setSelected((current) => updateSelectedPreviewStyle(current, "display", "none"));
    addLog("status", "Temporarily hid selected element");
  }

  function handleShowSelectedElement() {
    if (!selected?.selector) return;
    const displayValue = visibleDisplayValue(selected.styles?.display);
    setStyleProperty("display");
    setStyleValue(displayValue);
    updateStyleFileForProperty("display");
    previewStyleValue("display", displayValue);
    setSelected((current) => updateSelectedPreviewStyle(current, "display", displayValue));
    addLog("status", "Temporarily showed selected element");
  }

  function handleStyleValueKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement>,
    property: string
  ) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const nextValue = stepCssNumericValue(
        event.currentTarget.value,
        event.key === "ArrowUp" ? 1 : -1,
        event.shiftKey ? 10 : event.altKey ? 0.1 : 1
      );
      if (!nextValue) return;
      event.preventDefault();
      setStyleProperty(property);
      setStyleValue(nextValue);
      updateStyleFileForProperty(property);
      previewStyleValue(property, nextValue);
      return;
    }

    if (event.key !== "Enter") return;
    event.preventDefault();
    const value = event.currentTarget.value;
    skipStyleBlurCommitRef.current = { property, value };
    if (!hasStyleValueChanged(property, value)) {
      focusNextStyleInput(property);
      return;
    }
    void commitStyleToSource(property, value).then((committed) => {
      if (!committed) return;
      styleFocusValueRef.current = { property, value };
      focusNextStyleInput(property);
    });
  }

  function handleStyleValueBlur(property: string, value: string) {
    setFocusedStyleProperty((current) => (current === property ? "" : current));
    const skipped = skipStyleBlurCommitRef.current;
    if (skipped?.property === property && skipped.value === value) {
      skipStyleBlurCommitRef.current = null;
      return;
    }
    if (!hasStyleValueChanged(property, value)) return;
    void commitStyleToSource(property, value);
  }

  function handleStyleValueFocus(property: string, value: string) {
    styleFocusValueRef.current = { property, value };
    setFocusedStyleProperty(property);
    setStyleProperty(property);
    setStyleValue(value);
    updateStyleFileForProperty(property);
  }

  function hasStyleValueChanged(property: string, value: string) {
    const initial = styleFocusValueRef.current;
    const nextValue = normalizeCssValue(value);
    if (initial?.property === property) {
      return normalizeCssValue(initial.value) !== nextValue;
    }
    const sourceValue = selected?.styleSources?.[property]?.value;
    if (sourceValue != null) {
      return normalizeCssValue(sourceValue) !== nextValue;
    }
    const currentValue = selected?.styles?.[property];
    return currentValue == null || normalizeCssValue(currentValue) !== nextValue;
  }

  function focusNextStyleInput(property: string) {
    const index = styleProperties.indexOf(property);
    if (index < 0 || index >= styleProperties.length - 1) return;
    const nextProperty = styleProperties[index + 1];
    const nextInput = styleInputRefs.current.get(nextProperty);
    if (!nextInput) return;
    nextInput.focus();
    nextInput.select();
  }

  function updateStyleFileForProperty(property: string) {
    setStyleFile(resolveRuleStyleFile(selected, property));
  }

  function handleOpenSource() {
    if (!sourceLocation && !workspaceRoot) {
      addLog("error", "No source location or workspace root available");
      return;
    }
    if (!sourceLocation) {
      if (!window.confirm(`Open workspace in VS Code?\n${workspaceRoot}`)) return;
      window.location.href = `vscode://file/${workspaceRoot}`;
      return;
    }
    const lineText = sourceLocation.line ? `:${sourceLocation.line}${sourceLocation.column ? `:${sourceLocation.column}` : ""}` : "";
    if (!window.confirm(`Open source in VS Code?\n${sourceLocation.file}${lineText}`)) return;
    window.location.href = sourceLocation.url;
  }

  openSourceRef.current = handleOpenSource;

  function handleImageReplaceClick() {
    if (!selectedImage) return;
    if (!selectedImage.remote) return;
    setImageUrlDialog({
      open: true,
      value: selectedImage.rawSrc,
      error: ""
    });
  }

  function closeImageUrlDialog() {
    setImageUrlDialog({ open: false, value: "", error: "" });
  }

  async function handleImageUrlSubmit(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedImage) return;
    const nextUrl = imageUrlDialog.value.trim();
    if (!isHttpImageSource(nextUrl)) {
      setImageUrlDialog((current) => ({ ...current, error: "Enter an http(s) image URL." }));
      return;
    }
    try {
      if (selectedImage.kind === "img") {
        const file = resolveElementSourceFile(selected);
        if (!file) {
          setImageUrlDialog((current) => ({ ...current, error: "No editable source file found for this img." }));
          return;
        }
        await applyTextPatch({
          root: workspaceRoot,
          file,
          search: selected?.sourceAttributes?.src || selectedImage.rawSrc,
          searches: [selected?.sourceAttributes?.src || "", selected?.attributes?.src || "", selectedImage.rawSrc].filter(Boolean),
          attribute: "src",
          replace: nextUrl,
          line: selected?.elementSource?.line || selected?.source?.line
        });
        setSelected((current) => updateSelectedImageSrc(current, nextUrl));
        addLog("status", `Updated img src in ${file}`);
      } else {
        const file = resolveRuleStyleFile(selected, "background-image") || styleFile;
        if (!file || !selected?.selector) {
          setImageUrlDialog((current) => ({ ...current, error: "No editable source file found for this background image." }));
          return;
        }
        const source = resolveStyleSource(selected, "background-image");
        const nextValue = replaceCssUrl(source?.value || selected?.styles?.["background-image"] || styleValue, nextUrl);
        const selectors = selectorCandidates(selected, "background-image");
        await applyStylePatch({
          root: workspaceRoot,
          file,
          selector: selectors[0],
          selectors,
          property: "background-image",
          value: nextValue,
          line: source?.line,
          column: source?.column
        });
        setStyleProperty("background-image");
        setStyleValue(nextValue);
        setStyleFile(file);
        setSelected((current) => updateSelectedStyle(current, "background-image", nextValue, file, source));
        addLog("status", `Updated background image in ${file}`);
      }
      closeImageUrlDialog();
      reloadTarget(true);
    } catch (error) {
      setImageUrlDialog((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  async function handleAssetUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] || null;
    event.target.value = "";
    if (!file) return;
    if (selected?.tagName === "img" && selected.attributes?.src) {
      const targetAsset = resolveSelectedImageSource(selected);
      const targetAssets = resolveSelectedImageSources(selected);
      if (!targetAsset) {
        addLog("error", "No source image path available for the selected img");
        return;
      }
      try {
        const result = await replaceAsset(workspaceRoot, targetAsset, file, targetAssets);
        addLog("status", `Replaced asset ${result.relativePath} -> ${result.path}`);
        refreshAssetPreview();
        reloadTarget(true);
        return;
      } catch (error) {
        addLog("error", error instanceof Error ? error.message : String(error));
        return;
      }
    }
    const targetAsset = resolveSelectedBackgroundSource(selected, styleProperty, styleValue);
    const targetAssets = resolveSelectedBackgroundSources(selected, styleProperty, styleValue);
    if (!targetAsset) {
      addLog("error", "No source image path available for the selected background image");
      return;
    }
    try {
      const result = await replaceAsset(workspaceRoot, targetAsset, file, targetAssets);
      addLog("status", `Replaced asset ${result.relativePath} -> ${result.path}`);
      refreshAssetPreview();
      reloadTarget(true);
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
    }
  }

  function refreshAssetPreview() {
    setAssetPreviewVersion((version) => version + 1);
  }

  async function handleRunCodex() {
    if (!activeCodexTask) return;
    const taskId = activeCodexTask.id;
    const input = codexInput;
    const attachments = codexAttachments;
    const turnBusy = Boolean(codexTurnBusyRef.current[taskId] || busy);
    if (!input.trim() && !attachments.length && !turnBusy) return;
    if (turnBusy && !threadId) return;
    const submittedAt = Date.now();
    if (submittedAt - (codexLastSubmitAtRef.current[taskId] || 0) < CODEX_SEND_DEBOUNCE_MS) return;
    codexLastSubmitAtRef.current[taskId] = submittedAt;
    codexTurnBusyRef.current[taskId] = true;
    setBusy(true, taskId, turnBusy ? undefined : submittedAt);
    setCodexInput("");
    clearCodexAttachments(attachments);
    closeSkillMenu();
    const codexSelectedElements = codexElementEnabled
      ? selectedElements.map((element) => ({
          ...element,
          selector: lastDisplayedSelectors(element.pathSelector || element.selector || "")
        }))
      : [];
    const codexElementSummaries = codexSelectedElements
      .map(summarizeSelectedElement)
      .filter((summary): summary is ElementSummary => Boolean(summary));
    const turnPayload = {
      threadId,
      input,
      attachments: attachments.map((attachment) => ({
        type: "localImage" as const,
        path: attachment.path,
        name: attachment.name
      })),
      selectedElementContexts: codexSelectedElements
    };
    if (turnBusy && threadId) {
      if (!input.trim() && !attachments.length) {
        delete codexDeltaBuffersRef.current[taskId];
        settleAssistantMessage("Interrupted", undefined, taskId);
        codexTurnBusyRef.current[taskId] = false;
        setBusy(false, taskId);
        try {
          await interruptCodexTurn(threadId);
          addLog("status", "Interrupted current Codex turn");
        } catch (error) {
          addLog("error", error instanceof Error ? error.message : String(error));
        }
        return;
      }

      try {
        const result = await steerCodexTurn(turnPayload);
        if (result.steered) {
          if (codexSelectedElements.length) {
            setCodexElementEnabled(false);
            setCodexElementVisible(false);
          }
          renameCodexTaskFromInput(taskId, input);
          appendChatMessage("user", formatUserMessage(input, attachments.length), codexElementSummaries, taskId);
          appendChatMessage("assistant", "", undefined, taskId);
          return;
        }
        addLog("status", "Codex turn finished before it could be steered; starting a new turn");
      } catch (error) {
        restoreCodexComposer(taskId, input, attachments);
        addLog("error", error instanceof Error ? error.message : String(error));
        return;
      }
    }

    if (codexSelectedElements.length) {
      setCodexElementEnabled(false);
      setCodexElementVisible(false);
    }
    renameCodexTaskFromInput(taskId, input);
    appendChatMessage("user", formatUserMessage(input, attachments.length), codexElementSummaries, taskId);
    appendChatMessage("assistant", "", undefined, taskId);
    try {
      const thread = await ensureCodexThreadReady(activeCodexTask);
      codexThreadTaskIdsRef.current[thread] = taskId;
      updateCodexTask(taskId, (task) => ({ ...task, threadId: thread }));
      const result = await runCodexTurnWithRecovery(taskId, thread, { ...turnPayload, threadId: thread });
      flushAssistantDeltas();
      settleAssistantMessage(result.finalMessage, result.durationMs, taskId);
      if (result.appliedFiles?.length) {
        addLog("status", `Applied ${result.appliedFiles.length} Codex file(s)`);
      }
      if (result.durationMs != null) {
        markLastAssistantElapsed(result.durationMs, taskId);
      }
      codexTurnBusyRef.current[taskId] = false;
      setBusy(false, taskId);
    } catch (error) {
      addLog("error", error instanceof Error ? error.message : String(error));
      codexTurnBusyRef.current[taskId] = false;
      setBusy(false, taskId);
    }
  }

  async function runCodexTurnWithRecovery(taskId: string, thread: string, payload: Parameters<typeof runCodexTurn>[0]) {
    try {
      return await runCodexTurn(payload);
    } catch (error) {
      if (!isActiveCodexTurnError(error)) throw error;
      addLog("status", "Recovering stale Codex turn after page reload");
      await interruptCodexTurn(thread);
      codexTurnBusyRef.current[taskId] = false;
      setBusy(false, taskId);
      const currentTask = codexTasksRef.current.find((task) => task.id === taskId);
      if (currentTask) {
        const resumedThread = await ensureCodexThreadReady(currentTask);
        codexThreadTaskIdsRef.current[resumedThread] = taskId;
        updateCodexTask(taskId, (task) => ({ ...task, threadId: resumedThread }));
        payload = { ...payload, threadId: resumedThread };
      }
      codexTurnBusyRef.current[taskId] = true;
      setBusy(true, taskId);
      return await runCodexTurn(payload);
    }
  }

  async function ensureCodexThreadReady(task: CodexTask) {
    const threadOptions = {
      cwd: workspaceRoot,
      mode: "app-server" as const,
      model: codexModel || undefined,
      reasoningEffort: codexReasoningEffort || undefined,
      sandbox: codexSandbox,
      workspaceMode: codexWorkspaceMode
    };
    if (!task.threadId) {
      return (await startCodexThread(threadOptions)).threadId;
    }
    return (
      await resumeCodexThread({
        threadId: task.threadId,
        ...threadOptions
      })
    ).threadId;
  }

  function addLog(kind: "status" | "assistant" | "error", text: string) {
    if (!text.trim()) return;
    const normalizedKind = text.includes("codex app-server disposed") ? "status" : kind;
    const method = normalizedKind === "error" ? "error" : normalizedKind === "assistant" ? "info" : "debug";
    console[method](`[web-no-code:${normalizedKind}] ${text}`);
  }

  function appendChatMessage(role: ChatMessage["role"], content: string, elements?: ElementSummary[], taskId = activeCodexTask?.id) {
    if (!content.trim() && role !== "assistant") return;
    if (!taskId) return;
    updateCodexTask(taskId, (task) => ({
      ...task,
      chatMessages: [...task.chatMessages.slice(-30), { id: ++chatId, role, content, elements }]
    }));
  }

  function appendAssistantDelta(text: string, taskId = activeCodexTask?.id) {
    if (!text) return;
    if (!taskId) return;
    updateCodexTask(taskId, (task) => {
      const next = task.chatMessages.length
        ? [...task.chatMessages]
        : [{ id: ++chatId, role: "assistant" as const, content: "" }];
      const last = next.at(-1);
      if (!last || last.role !== "assistant") {
        next.push({ id: ++chatId, role: "assistant", content: text });
      } else {
        next[next.length - 1] = { ...last, content: `${last.content}${text}` };
      }
      return { ...task, chatMessages: next.slice(-31) };
    });
  }

  function queueAssistantDelta(text: string, taskId?: string) {
    if (!text || !taskId) return;
    codexDeltaBuffersRef.current[taskId] = `${codexDeltaBuffersRef.current[taskId] || ""}${text}`;
    if (codexDeltaFlushFrameRef.current) return;
    codexDeltaFlushFrameRef.current = window.requestAnimationFrame(() => {
      codexDeltaFlushFrameRef.current = 0;
      flushAssistantDeltas();
    });
  }

  function flushAssistantDeltas() {
    window.cancelAnimationFrame(codexDeltaFlushFrameRef.current);
    codexDeltaFlushFrameRef.current = 0;
    const buffers = codexDeltaBuffersRef.current;
    codexDeltaBuffersRef.current = {};
    for (const [taskId, text] of Object.entries(buffers)) {
      appendAssistantDelta(text, taskId);
    }
  }

  function settleAssistantMessage(finalMessage: string, elapsedMs?: number, taskId = activeCodexTask?.id) {
    if (!taskId) return;
    updateCodexTask(taskId, (task) => {
      if (!task.chatMessages.length) {
        return { ...task, chatMessages: [{ id: ++chatId, role: "assistant", content: finalMessage, elapsedMs }] };
      }
      const next = [...task.chatMessages];
      const last = next.at(-1);
      if (!last || last.role !== "assistant") {
        next.push({ id: ++chatId, role: "assistant", content: finalMessage, elapsedMs });
      } else if (!last.content.trim()) {
        next[next.length - 1] = { ...last, content: finalMessage, elapsedMs };
      } else {
        next[next.length - 1] = { ...last, elapsedMs };
      }
      return { ...task, chatMessages: next.slice(-31) };
    });
  }

  function restoreAssistantMessage(finalMessage: string, elapsedMs: number | undefined, taskId: string) {
    updateCodexTask(taskId, (task) => {
      const next = [...task.chatMessages];
      const last = next.at(-1);
      if (!last || last.role !== "assistant") {
        next.push({ id: ++chatId, role: "assistant", content: finalMessage, elapsedMs });
      } else {
        next[next.length - 1] = { ...last, content: finalMessage, elapsedMs };
      }
      return { ...task, chatMessages: next.slice(-31) };
    });
  }

  function markLastAssistantElapsed(elapsedMs: number, taskId = activeCodexTask?.id) {
    if (!taskId) return;
    updateCodexTask(taskId, (task) => {
      const next = [...task.chatMessages];
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index].role !== "assistant") continue;
        next[index] = { ...next[index], elapsedMs };
        break;
      }
      return { ...task, chatMessages: next };
    });
  }

  function isInspectorShortcut(event: KeyboardEvent) {
    return event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "c";
  }

  function isDragShortcut(event: KeyboardEvent) {
    return event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "d";
  }

  function isOpenSourceShortcut(event: KeyboardEvent) {
    return event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "s";
  }

  function temporaryInspectorModeFromEvent(event: KeyboardEvent): "select" | "drag" | null {
    if (event.repeat || event.metaKey || event.ctrlKey) return null;
    if ((event.key === "Alt" || event.key === "Option") && event.altKey) {
      return "select";
    }
    return null;
  }

  function temporaryInspectorModeFromKey(key: string): "select" | "drag" | null {
    if (key === "Alt" || key === "Option") return "select";
    return null;
  }

  function normalizeTemporaryInspectorMode(value: unknown): "select" | "drag" | null {
    return value === "select" || value === "drag" ? value : null;
  }

  function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
  }

  function isCodexPasteTarget(target: EventTarget | null) {
    return target instanceof HTMLElement && Boolean(target.closest(".codex-input-wrap"));
  }

  const filteredSkills = useMemo(() => {
    const query = skillQuery.toLowerCase();
    return skills
      .filter((skill) => !query || skill.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [skills, skillQuery]);

  useEffect(() => {
    setSkillActiveIndex((current) => Math.min(current, Math.max(0, filteredSkills.length - 1)));
  }, [filteredSkills.length]);

  useEffect(() => {
    if (!skillMenuOpen) return;
    const menu = skillMenuRef.current;
    const activeItem = menu?.querySelector<HTMLButtonElement>("[data-skill-active='true']");
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [skillActiveIndex, skillMenuOpen, filteredSkills.length]);

  return (
    <div className={cssRulesDrawerOpen ? "workbench" : "workbench css-rules-closed"}>
      <aside className="left-rail">
        <div className="brand-mark">
          <SquareCode size={22} />
          <div>
            <strong>{appTitle}</strong>
            <span>Local visual source editor</span>
          </div>
        </div>

        <div className="rail-switch" aria-label="Left panel view">
          <button className={leftView === "setup" ? "active" : ""} onClick={() => setLeftView("setup")} type="button">
            <Settings2 size={15} />
            Setup
          </button>
          <button className={leftView === "codex" ? "active" : ""} onClick={() => setLeftView("codex")} type="button">
            <Sparkles size={15} />
            Codex
          </button>
        </div>

        {leftView === "setup" ? (
          <>
            <section className="panel">
              <div className="panel-title">
                <Monitor size={16} />
                Target
              </div>
              <label>
                URL
                <input value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} />
              </label>
              <label>
                Workspace
                <input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} />
              </label>
              <button className="command-button" onClick={() => reloadTarget()}>
                <RefreshCw size={16} />
                Reload
              </button>
            </section>

            <section className="panel">
              <div className="panel-title">
                <Settings2 size={16} />
                Provider
              </div>
              <label>
                Mode
                <input value="app-server" readOnly />
              </label>
              <button className="command-button ghost" onClick={refreshProviderStatus}>
                <Bot size={16} />
                Check
              </button>
              <div className={`provider-pill ${providerName === "unavailable" ? "bad" : ""}`}>
                <span>{providerName}</span>
                <small>{providerStatus}</small>
              </div>
            </section>
          </>
        ) : (
          <div className="codex-workspace">
            <section className="panel codex-panel left-codex-panel">
              <div className="codex-task-bar" aria-label="Codex tasks">
                <div className="codex-task-list" ref={codexTaskListRef}>
                  {codexTasks.map((task) => (
                    <div
                      key={task.id}
                      ref={(node) => {
                        if (node) codexTaskTabRefs.current.set(task.id, node);
                        else codexTaskTabRefs.current.delete(task.id);
                      }}
                      className={task.id === activeCodexTask?.id ? "codex-task-tab active" : "codex-task-tab"}
                      title={task.title}
                    >
                      <button className="codex-task-switch" type="button" onClick={() => switchCodexTask(task.id)}>
                        {task.busy ? (
                          <span className="codex-task-spinner" aria-hidden="true">
                            <Loader2 className="spin" size={15} />
                          </span>
                        ) : null}
                        <span>{task.title}</span>
                      </button>
                      {task.id === activeCodexTask?.id ? (
                        <button
                          className="codex-task-delete"
                          type="button"
                          onClick={() => deleteCodexTask(task.id)}
                          title={`Delete ${task.title}`}
                          aria-label={`Delete ${task.title}`}
                        >
                          <X size={12} />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
              {pendingDeleteCodexTask ? (
                <div className="codex-delete-confirm" role="alert">
                  <span>Delete "{pendingDeleteCodexTask.title}"?</span>
                  <button type="button" onClick={() => confirmDeleteCodexTask(pendingDeleteCodexTask.id)}>
                    Delete
                  </button>
                  <button type="button" onClick={() => setPendingDeleteCodexTaskId("")}>
                    Cancel
                  </button>
                </div>
              ) : null}
              <div className="chat-panel" ref={chatPanelRef} aria-live="polite">
                {chatMessages.length ? (
                  chatMessages.map((message, index) => (
                    <CodexChatMessageView
                      key={message.id}
                      message={message}
                      streaming={busy && message.role === "assistant" && index === chatMessages.length - 1}
                      activityElapsedMs={codexActivityElapsedMs}
                    />
                  ))
                ) : (
                  <div className="chat-empty">Codex responses will stream here.</div>
                )}
              </div>
              <div
                className="codex-input-wrap"
                onPasteCapture={handleCodexInputPaste}
                onDrop={handleCodexDrop}
                onDragOver={handleCodexDragOver}
              >
                {selectedElements.length > 0 && codexElementVisible ? (
                  <div
                    ref={codexContextListRef}
                    className="codex-context-list"
                    aria-label={`${selectedElements.length} selected elements for Codex`}
                  >
                    {selectedElements.map((element, index) => (
                      <div
                        className={element.selector === selected?.selector ? "codex-context-chip active" : "codex-context-chip"}
                        data-codex-context-active={element.selector === selected?.selector}
                        key={element.selector}
                      >
                        {selectedElements.length > 1 ? (
                          <span className="codex-context-index" aria-hidden="true">{index + 1}</span>
                        ) : null}
                        <code title={element.selector}>{selectedElementLabel(element)}</code>
                        {selectedElements.length === 1 && element.text ? <small title={element.text}>{element.text}</small> : null}
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => removeSelectedElement(element.selector || "", index)}
                          title={`Remove ${selectedElementLabel(element)} from selection`}
                          aria-label={`Remove ${selectedElementLabel(element)} from selection`}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <textarea
                  className="codex-input"
                  value={codexInput}
                  placeholder="Describe the edit you want Codex to make"
                  onChange={handleCodexInputChange}
                  onKeyDown={handleCodexInputKeyDown}
                />
                {codexAttachments.length ? (
                  <div className="codex-attachments" aria-label="Codex image attachments">
                    {codexAttachments.map((attachment) => (
                      <div key={attachment.id} className="codex-attachment">
                        <img src={attachment.previewUrl} alt={attachment.name} />
                        <span>{attachment.name}</span>
                        <button type="button" className="icon-button" onClick={() => removeCodexAttachment(attachment.id)} title="Remove image">
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {codexPasteStatus ? <div className="codex-paste-status">{codexPasteStatus}</div> : null}
                <div className="codex-input-actions">
                  <div className="codex-model-picker" ref={codexModelPickerRef}>
                    <button
                      className="codex-model-button"
                      type="button"
                      onClick={toggleCodexModelPicker}
                      title={`Select Codex model: ${codexModelLabel}`}
                      aria-haspopup="listbox"
                      aria-expanded={codexModelPickerOpen}
                      disabled={busy}
                    >
                      <Sparkles size={14} />
                      <span>{codexModelLabel}</span>
                      <ChevronDown size={14} aria-hidden="true" />
                    </button>
                    {codexModelPickerOpen ? (
                      <div className="codex-model-menu" aria-label="Codex model and reasoning settings">
                        {codexModelsLoading ? <p>Loading available models...</p> : null}
                        {!codexModelsLoading && !codexModels.length ? <p>No models are available from Codex.</p> : null}
                        {selectedCodexModel?.supportedReasoningEfforts.length ? (
                          <section className="codex-picker-section" aria-labelledby="codex-reasoning-effort-label">
                            <span id="codex-reasoning-effort-label" className="codex-picker-heading">
                              Reasoning effort
                              <small>{codexReasoningEffortLabel}</small>
                            </span>
                            <div
                              className="codex-effort-slider"
                              style={{
                                "--effort-progress": `${codexReasoningEffortProgress}%`,
                                "--effort-color": `hsl(158 34% ${codexReasoningEffortLightness}%)`,
                                "--effort-focus-color": `hsl(158 34% ${codexReasoningEffortLightness}% / 0.5)`
                              } as CSSProperties}
                            >
                              <input
                                type="range"
                                min={0}
                                max={selectedCodexModel.supportedReasoningEfforts.length - 1}
                                step={1}
                                value={codexReasoningEffortIndex}
                                aria-label="Reasoning effort"
                                aria-valuetext={codexReasoningEffortLabel}
                                title={selectedCodexReasoningEffort?.description || codexReasoningEffortLabel}
                                onChange={handleCodexReasoningEffortChange}
                              />
                              <div className="codex-effort-ticks" aria-hidden="true">
                                {selectedCodexModel.supportedReasoningEfforts.map((option) => (
                                  <i key={option.reasoningEffort} />
                                ))}
                              </div>
                              <div className="codex-effort-range" aria-hidden="true">
                                <span>{formatReasoningEffort(selectedCodexModel.supportedReasoningEfforts[0]?.reasoningEffort || "")}</span>
                                <span>{formatReasoningEffort(selectedCodexModel.supportedReasoningEfforts.at(-1)?.reasoningEffort || "")}</span>
                              </div>
                            </div>
                          </section>
                        ) : null}
                        <section className="codex-picker-section codex-model-options" aria-labelledby="codex-model-label">
                          <span id="codex-model-label" className="codex-picker-heading">
                            Model
                          </span>
                          <div role="listbox" aria-label="Select Codex model">
                            {codexModels.map((model) => {
                              const active = codexModel ? model.model === codexModel : model.isDefault;
                              return (
                                <button
                                  key={model.id}
                                  className={active ? "active" : ""}
                                  type="button"
                                  role="option"
                                  aria-selected={active}
                                  onClick={() => selectCodexModel(model)}
                                >
                                  <span>
                                    <strong>{model.displayName}</strong>
                                    {model.isDefault ? <small>Default</small> : null}
                                    {model.description ? <em>{model.description}</em> : null}
                                  </span>
                                  {active ? <Check size={16} aria-hidden="true" /> : null}
                                </button>
                              );
                            })}
                          </div>
                        </section>
                      </div>
                    ) : null}
                  </div>
                  <button
                    className="icon-button codex-settings-button"
                    type="button"
                    onClick={openCodexSettings}
                    title="Codex settings"
                    aria-label="Codex settings"
                  >
                    <Settings2 size={15} />
                  </button>
                  <input
                    ref={codexFileInputRef}
                    className="visually-hidden"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleCodexAttachmentInput}
                  />
                  <button
                    className="icon-button codex-attach-button"
                    type="button"
                    onClick={() => codexFileInputRef.current?.click()}
                    title="Attach image"
                    aria-label="Attach image"
                  >
                    <ImageUp size={15} />
                  </button>
                  <button
                    className="icon-button codex-new-thread-button"
                    type="button"
                    onClick={createCodexTask}
                    title={canCreateCodexTask ? "New Codex thread" : `Maximum of ${MAX_CODEX_TASKS} Codex threads reached`}
                    data-tooltip={
                      canCreateCodexTask ? "New Codex thread" : `Maximum of ${MAX_CODEX_TASKS} Codex threads reached`
                    }
                    aria-label={canCreateCodexTask ? "New Codex thread" : `Maximum of ${MAX_CODEX_TASKS} Codex threads reached`}
                    disabled={!canCreateCodexTask}
                  >
                    <Plus size={15} />
                  </button>
                  <button
                    className="icon-button codex-send-button"
                    onClick={handleRunCodex}
                    title={codexSendLabel}
                    aria-label={codexSendLabel}
                  >
                    {busy ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
                  </button>
                </div>
                {skillMenuOpen ? (
                  <div className="skill-menu" ref={skillMenuRef}>
                    {filteredSkills.length ? (
                      filteredSkills.map((skill, index) => (
                        <button
                          key={skill.name}
                          className={index === skillActiveIndex ? "active" : ""}
                          data-skill-active={index === skillActiveIndex ? "true" : undefined}
                          type="button"
                          onClick={() => insertSkill(skill.name)}
                          onMouseEnter={() => setSkillActiveIndex(index)}
                        >
                          <strong>${skill.name}</strong>
                          {skill.description ? <span>{skill.description}</span> : null}
                        </button>
                      ))
                    ) : (
                      <p>No matching skills</p>
                    )}
                  </div>
                ) : null}
              </div>
              {codexSettingsOpen ? (
                <div className="codex-settings-backdrop" onMouseDown={closeCodexSettings}>
                  <aside
                    className="codex-settings-drawer"
                    aria-label="Codex settings"
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <div className="codex-settings-header">
                      <div>
                        <strong>Codex settings</strong>
                        <span>Workspace and instruction files</span>
                      </div>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={closeCodexSettings}
                        title="Close settings"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <label className="codex-settings-field">
                      Workspace
                      <select
                        value={draftCodexWorkspaceMode}
                        onChange={(event) => setDraftCodexWorkspaceMode(event.target.value === "direct" ? "direct" : "shadow")}
                      >
                        <option value="direct">Fast direct source workspace</option>
                        <option value="shadow">Safe shadow workspace</option>
                      </select>
                    </label>
                    <label className="codex-settings-field">
                      Sandbox
                      <select
                        value={draftCodexSandbox}
                        onChange={(event) =>
                          setDraftCodexSandbox(event.target.value === "danger-full-access" ? "danger-full-access" : "workspace-write")
                        }
                      >
                        <option value="danger-full-access">Danger full access</option>
                        <option value="workspace-write">Workspace write</option>
                      </select>
                    </label>
                    <section className="agents-document agents-document-global" aria-labelledby="global-agents-title">
                      <div className="agents-document-header">
                        <div>
                          <strong id="global-agents-title">Global AGENTS.md</strong>
                          <small>~/.codex/AGENTS.md</small>
                        </div>
                        <button
                          type="button"
                          className="icon-button agents-expand-button"
                          onClick={() => setAgentsViewerMode("global")}
                          title="Expand global AGENTS.md"
                          aria-label="Expand global AGENTS.md"
                        >
                          <Maximize2 size={14} />
                        </button>
                      </div>
                      <textarea
                        className="agents-document-input agents-document-input-global"
                        value={draftGlobalAgentsInstructions}
                        placeholder="No global rules configured in ~/.codex/AGENTS.md"
                        onChange={(event) => handleGlobalAgentsInstructionsChange(event.target.value)}
                        aria-label="Global AGENTS.md rules"
                      />
                      <div className="agents-document-meta">
                        <span>{globalAgentsInstructionsStatus}</span>
                        <span>{globalAgentsStats.lines} lines</span>
                        <span>{globalAgentsStats.characters} characters</span>
                      </div>
                    </section>
                    <section className="agents-document agents-document-project" aria-labelledby="project-agents-title">
                      <div className="agents-document-header">
                        <div>
                          <strong id="project-agents-title">Project AGENTS.md</strong>
                          <small>AGENTS.md</small>
                        </div>
                        <button
                          type="button"
                          className="icon-button agents-expand-button"
                          onClick={() => setAgentsViewerMode("project")}
                          title="Expand project AGENTS.md editor"
                          aria-label="Expand project AGENTS.md editor"
                        >
                          <Maximize2 size={14} />
                        </button>
                      </div>
                      <textarea
                        className="agents-document-input agents-document-input-project"
                        value={draftAgentsInstructions}
                        placeholder="Project instructions for Codex"
                        onChange={(event) => handleAgentsInstructionsChange(event.target.value)}
                        disabled={!workspaceRoot}
                        aria-label="Project AGENTS.md rules"
                      />
                      <div className="agents-document-meta">
                        <span>{agentsInstructionsStatus}</span>
                        <span>{projectAgentsStats.lines} lines</span>
                        <span>{projectAgentsStats.characters} characters</span>
                      </div>
                    </section>
                    <div className="codex-settings-actions">
                      <button
                        type="button"
                        className="command-button"
                        onClick={() => void saveCodexSettings()}
                        disabled={!codexSettingsDirty || codexSettingsSaving}
                      >
                        {codexSettingsSaving ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
                        Save
                      </button>
                    </div>
                  </aside>
                  {agentsViewerMode
                    ? createPortal(
                    <div
                      className="agents-viewer-backdrop"
                      onMouseDown={(event) => {
                        event.stopPropagation();
                        setAgentsViewerMode(null);
                      }}
                    >
                      <section
                        className="agents-viewer"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="agents-viewer-title"
                        onMouseDown={(event) => event.stopPropagation()}
                      >
                        <header className="agents-viewer-header">
                          <div>
                            <strong id="agents-viewer-title">
                              {agentsViewerMode === "global" ? "Global AGENTS.md" : "Project AGENTS.md"}
                            </strong>
                            <span>
                              {agentsViewerMode === "global" ? "~/.codex/AGENTS.md" : "AGENTS.md"}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="icon-button"
                            onClick={() => setAgentsViewerMode(null)}
                            title="Close expanded view"
                            aria-label="Close expanded view"
                          >
                            <X size={16} />
                          </button>
                        </header>
                        <textarea
                          className="agents-viewer-input"
                          value={agentsViewerMode === "global" ? draftGlobalAgentsInstructions : draftAgentsInstructions}
                          placeholder={
                            agentsViewerMode === "global"
                              ? "No global rules configured in ~/.codex/AGENTS.md"
                              : "Project instructions for Codex"
                          }
                          disabled={agentsViewerMode === "project" && !workspaceRoot}
                          onChange={
                            agentsViewerMode === "global"
                              ? (event) => handleGlobalAgentsInstructionsChange(event.target.value)
                              : (event) => handleAgentsInstructionsChange(event.target.value)
                          }
                          autoFocus
                          aria-label={`${agentsViewerMode === "global" ? "Global" : "Project"} AGENTS.md rules`}
                        />
                        <footer className="agents-viewer-footer">
                          <span>{agentsViewerMode === "global" ? "~/.codex/AGENTS.md" : "AGENTS.md"}</span>
                          <span>
                            {agentsViewerMode === "global" ? globalAgentsStats.lines : projectAgentsStats.lines} lines ·{" "}
                            {agentsViewerMode === "global" ? globalAgentsStats.characters : projectAgentsStats.characters} characters
                          </span>
                        </footer>
                      </section>
                    </div>,
                    document.body
                  )
                    : null}
                </div>
              ) : null}
            </section>
          </div>
        )}
      </aside>

      <main className="canvas-zone">
        <header className="topbar">
          <button
            className={inspectorEnabled || temporaryInspectorMode === "select" ? "icon-button active" : "icon-button"}
            title="Select element (Ctrl+C, Shift+click to add, hold Option)"
            data-tooltip="Select - Ctrl+C · Shift+click adds"
            aria-keyshortcuts="Control+C"
            onClick={toggleInspectorMode}
          >
            <MousePointer2 size={18} />
          </button>
          <button
            className={dragEnabled || temporaryInspectorMode === "drag" ? "icon-button active" : "icon-button"}
            title="Drag element (Ctrl+D)"
            data-tooltip="Drag element - Ctrl+D"
            aria-keyshortcuts="Control+D"
            onClick={toggleDragMode}
          >
            <Move size={18} />
          </button>
          <div className="selected-readout">
            <Crosshair size={15} />
            {selected?.selector ? (
              <div ref={selectorBreadcrumbRef} className="selector-breadcrumb" aria-label="Selected element path">
                {selectorBreadcrumbs(selected.pathSelector || selected.selector).map((item, index, items) => (
                  <div className="selector-breadcrumb-step" key={item.selector}>
                    {index ? (
                      <button
                        className="selector-sibling-trigger"
                        type="button"
                        title={`Show siblings of ${item.label}`}
                        aria-label={`Show siblings of ${item.label}`}
                        aria-haspopup="menu"
                        aria-expanded={siblingPicker?.currentSelector === item.selector}
                        onClick={(event) => openSiblingPicker(event, item.selector, items[index - 1]?.label || "parent")}
                      >
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      className="selector-breadcrumb-target"
                      type="button"
                      title={item.selector}
                      onClick={() => selectElementBySelector(item.selector)}
                    >
                      <code>{item.label}</code>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <span>No element selected</span>
            )}
          </div>
          <div className="device-switch" aria-label="Preview width">
            {DEVICE_PRESETS.map((preset) => (
              <button
                key={preset.value}
                className={deviceWidth === preset.value ? "active" : ""}
                onClick={() => handleDeviceWidthChange(preset.value)}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <button
            className="icon-button css-rules-toggle"
            type="button"
            title="CSS Rules"
            data-tooltip="CSS Rules"
            aria-label="Open CSS rules"
            aria-expanded={cssRulesDrawerOpen}
            onClick={() => setCssRulesDrawerOpen(true)}
          >
            <Code2 size={18} />
          </button>
        </header>
        <div className="preview-url" aria-label="Preview URL">
          <Globe2 size={14} aria-hidden="true" />
          <input
            className="preview-url-scroll"
            value={previewUrlInput}
            aria-label="Current preview URL"
            title={previewUrlInput}
            spellCheck={false}
            onChange={(event) => setPreviewUrlInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                navigatePreviewUrl();
              }
              if (event.key === "Escape") {
                setPreviewUrlInput(previewUrl);
                event.currentTarget.blur();
              }
            }}
          />
          <button
            className="preview-query-button"
            type="button"
            title="Edit query parameters"
            aria-label="Edit query parameters"
            aria-expanded={previewQueryEditor.open}
            onClick={openPreviewQueryEditor}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
          </button>
          <button
            className="preview-refresh-button"
            type="button"
            title="Refresh preview"
            aria-label="Refresh preview"
            onClick={refreshPreview}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="target-stage">
          <iframe
            ref={iframeRef}
            src={loadedUrl}
            title="Target preview"
            className={`target-frame ${deviceWidth === "full" ? "full" : ""}`}
            style={deviceWidth === "full" ? undefined : { width: deviceWidth }}
            onLoad={() => setTimeout(postInspectorState, 300)}
          />
        </div>
      </main>

      {cssRulesDrawerOpen ? <button className="drawer-backdrop" type="button" aria-label="Close CSS rules" onClick={() => setCssRulesDrawerOpen(false)} /> : null}
      <aside className={cssRulesDrawerOpen ? "right-rail open" : "right-rail"}>
        <section className="panel tall">
          <div className="panel-title">
            <Code2 size={16} />
            CSS Rules
            <button
              className="icon-button drawer-close"
              type="button"
              title="Close CSS rules"
              aria-label="Close CSS rules"
              onClick={() => setCssRulesDrawerOpen(false)}
            >
              <X size={14} />
            </button>
          </div>

          <div className="element-card">
            <strong>{selected?.tagName || "Select an element"}</strong>
            <span>
              {selected?.selector
                ? displaySelector(selected.pathSelector || selected.selector)
                : "Use the pointer tool in the canvas"}
            </span>
          </div>
          <div className="visibility-actions">
            <button
              className="command-button ghost"
              type="button"
              onClick={selectedHidden ? handleShowSelectedElement : handleHideSelectedElement}
              disabled={!selected?.selector}
            >
              {selectedHidden ? <Eye size={15} /> : <EyeOff size={15} />}
              {selectedHidden ? "Show" : "Hide"}
            </button>
          </div>

          <div className="style-grid">
            {selected?.selector && !styleEntries.length ? (
              <div className="style-empty">No source CSS rules found</div>
            ) : null}
            {styleEntries.map(([property, value]) => {
              const displayValue = normalizeCssValue(value);
              return (
              <div
                key={property}
                className={property === focusedStyleProperty ? "style-row active" : "style-row"}
              >
                <span>{property}</span>
                <div className="style-value">
                  {isCssColor(displayValue) ? <i style={{ backgroundColor: displayValue }} aria-hidden="true" /> : null}
                  <input
                    ref={(node) => {
                      if (node) {
                        styleInputRefs.current.set(property, node);
                      } else {
                        styleInputRefs.current.delete(property);
                      }
                    }}
                    value={property === styleProperty ? styleValue : displayValue}
                    title={property === styleProperty ? styleValue : displayValue}
                    onChange={(event) => handleStyleValueChange(property, event.target.value)}
                    onKeyDown={(event) => handleStyleValueKeyDown(event, property)}
                    onBlur={(event) => {
                      handleStyleValueBlur(property, event.currentTarget.value);
                    }}
                  onFocus={() => handleStyleValueFocus(property, property === styleProperty ? styleValue : displayValue)}
                  />
                </div>
              </div>
              );
            })}
          </div>

          <label className="source-file-field">
            Source file
            <span className="source-file-control">
              <code
                ref={sourceFileDisplayRef}
                className={styleFile ? "source-file-display" : "source-file-display empty"}
                title={displayedStyleFile || "No source file detected"}
              >
                {displayedStyleFile || "No source file detected"}
              </code>
              <button
                className="icon-button"
                title="Open source (Ctrl+S)"
                data-tooltip="Open source - Ctrl+S"
                aria-keyshortcuts="Control+S"
                onClick={handleOpenSource}
                disabled={!sourceLocation && !workspaceRoot}
                type="button"
              >
                <FileCode2 size={18} />
              </button>
            </span>
          </label>
          {selectedImage ? (
            <label className="image-replace" onClick={handleImageReplaceClick}>
              <span>
                <ImageUp size={16} />
                {selectedImage.remote ? "Replace URL" : "Replace Image"}
              </span>
              <img src={selectedImage.src} alt="Selected asset preview" />
              <small>{selectedImage.kind === "img" ? "img src" : "background-image"}</small>
              {selectedImage.remote ? null : <input type="file" accept="image/*" onChange={handleAssetUpload} />}
            </label>
          ) : null}
        </section>
      </aside>
      {imageUrlDialog.open ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeImageUrlDialog}>
          <form className="image-url-dialog" onSubmit={handleImageUrlSubmit} onMouseDown={(event) => event.stopPropagation()}>
            <div className="image-url-dialog__header">
              <strong>Replace image URL</strong>
              <button className="icon-button" type="button" onClick={closeImageUrlDialog} title="Close">
                <X size={16} />
              </button>
            </div>
            <label>
              URL
              <input
                autoFocus
                value={imageUrlDialog.value}
                onChange={(event) => setImageUrlDialog({ open: true, value: event.target.value, error: "" })}
                placeholder="https://example.com/image.png"
              />
            </label>
            {imageUrlDialog.error ? <p>{imageUrlDialog.error}</p> : null}
            <div className="image-url-dialog__actions">
              <button type="button" onClick={closeImageUrlDialog}>Cancel</button>
              <button type="submit">Replace</button>
            </div>
          </form>
        </div>
      ) : null}
      {previewQueryEditor.open ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closePreviewQueryEditor}>
          <form
            className="preview-query-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-query-dialog-title"
            onSubmit={applyPreviewQueryParams}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="preview-query-dialog__header">
              <div>
                <strong id="preview-query-dialog-title">Query parameters</strong>
                <span>{previewQueryEditor.params.length} parameters</span>
              </div>
              <button className="icon-button" type="button" onClick={closePreviewQueryEditor} title="Close">
                <X size={16} />
              </button>
            </header>
            <div className="preview-query-dialog__columns" aria-hidden="true">
              <span>Key</span>
              <span>Value</span>
            </div>
            <div className="preview-query-dialog__list">
              {previewQueryEditor.params.length ? previewQueryEditor.params.map((param, index) => (
                <div className="preview-query-row" key={param.id}>
                  <input
                    autoFocus={index === 0}
                    value={param.key}
                    onChange={(event) => updatePreviewQueryParam(param.id, "key", event.target.value)}
                    placeholder="parameter"
                    aria-label={`Parameter ${index + 1} key`}
                  />
                  <input
                    value={param.value}
                    onChange={(event) => updatePreviewQueryParam(param.id, "value", event.target.value)}
                    placeholder="value"
                    aria-label={`Parameter ${index + 1} value`}
                  />
                  <button
                    type="button"
                    title="Remove parameter"
                    aria-label={`Remove parameter ${param.key || index + 1}`}
                    onClick={() => removePreviewQueryParam(param.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              )) : (
                <p className="preview-query-dialog__empty">No query parameters</p>
              )}
            </div>
            {previewQueryEditor.error ? <p className="preview-query-dialog__error">{previewQueryEditor.error}</p> : null}
            <footer className="preview-query-dialog__actions">
              <button className="preview-query-add" type="button" onClick={addPreviewQueryParam}>
                <Plus size={14} aria-hidden="true" />
                Add parameter
              </button>
              <span />
              <button type="button" onClick={closePreviewQueryEditor}>Cancel</button>
              <button type="submit">Apply &amp; reload</button>
            </footer>
          </form>
        </div>
      ) : null}
      {siblingPicker ? (
        <div
          ref={siblingPickerRef}
          className="selector-sibling-menu"
          role="menu"
          aria-label={`Elements inside ${siblingPicker.parentLabel}`}
          style={{ left: siblingPicker.left, top: siblingPicker.top }}
        >
          <div className="selector-sibling-menu__header">
            <span>Elements</span>
            <small>{siblingPicker.options.length || ""}</small>
          </div>
          {siblingPicker.loading ? (
            <div className="selector-sibling-menu__status">
              <Loader2 className="spin" size={14} aria-hidden="true" />
              Loading elements...
            </div>
          ) : siblingPicker.options.length ? (
            <div className="selector-sibling-menu__list">
              {siblingPicker.options.map((option) => {
                const active = option.selector === siblingPicker.currentSelector;
                return (
                  <button
                    key={option.selector}
                    className={active ? "active" : ""}
                    type="button"
                    role="menuitem"
                    aria-current={active ? "true" : undefined}
                    title={option.selector}
                    onClick={() => selectSibling(option.selector)}
                  >
                    <span className="selector-sibling-menu__marker">{active ? <Check size={14} /> : null}</span>
                    <span>
                      <code>{option.label}</code>
                      {option.text ? <small>{option.text}</small> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="selector-sibling-menu__status">No sibling elements</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function normalizeSiblingOptions(value: unknown): SiblingOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const option = item as Record<string, unknown>;
    const selector = typeof option.selector === "string" ? option.selector : "";
    const label = typeof option.label === "string" ? option.label : "";
    if (!selector || !label) return [];
    return [{
      selector,
      label,
      text: typeof option.text === "string" ? option.text : undefined
    }];
  });
}

function createPreviewQueryParam(key = "", value = ""): PreviewQueryParam {
  previewQueryParamId += 1;
  return { id: `preview-query-${previewQueryParamId}`, key, value };
}

function resolveSelectedImage(
  selected: SelectedElementContext | null,
  styleProperty: string,
  styleValue: string,
  targetUrl: string,
  targetAliases: TargetAlias[],
  workspaceRoot: string,
  assetPreviewVersion = 0
): { kind: "img" | "background"; src: string; rawSrc: string; remote: boolean } | null {
  if (selected?.tagName === "img" && selected.attributes?.src) {
    const rawSrc = selected.sourceAttributes?.src || selected.attributes.src;
    const remote = isRemoteImageSource(rawSrc, selected.url || targetUrl);
    return {
      kind: "img",
      src: resolveAssetPreviewUrl(selected.attributes.src, selected.url || targetUrl, targetAliases, workspaceRoot, remote ? 0 : assetPreviewVersion),
      rawSrc,
      remote
    };
  }
  const backgroundValue =
    styleProperty === "background-image" ? styleValue : selected?.styles?.["background-image"] || "";
  const backgroundSrc = extractCssUrl(backgroundValue);
  if (backgroundSrc) {
    const backgroundSource = resolveBackgroundAssetSource(selected?.styleSources);
    const sourceSrc = extractCssUrl(backgroundSource?.value || "") || backgroundSrc;
    const remote = isRemoteImageSource(sourceSrc, selected?.url || targetUrl);
    return {
      kind: "background",
      src: resolveAssetPreviewUrl(
        sourceSrc,
        selected?.url || targetUrl,
        targetAliases,
        workspaceRoot,
        remote ? 0 : assetPreviewVersion,
        backgroundSource?.file
      ),
      rawSrc: sourceSrc,
      remote
    };
  }
  return null;
}

function summarizeSelectedElement(selected: SelectedElementContext | null): ElementSummary | null {
  if (!selected?.selector) return null;
  const source = selected.elementSource || selected.source;
  const line = source?.line ? `:${source.line}${source.column ? `:${source.column}` : ""}` : "";
  return {
    tagName: selected.tagName || "element",
    selector: selected.selector,
    source: source?.file ? `${source.file}${line}` : ""
  };
}

function chatMessageElements(message: ChatMessage) {
  const elements = Array.isArray(message.elements) ? message.elements.filter(isElementSummary) : [];
  if (elements.length) return elements;
  return isElementSummary(message.element) ? [message.element] : [];
}

function isElementSummary(value: unknown): value is ElementSummary {
  if (!value || typeof value !== "object") return false;
  const element = value as Partial<ElementSummary>;
  return (
    typeof element.tagName === "string" &&
    typeof element.selector === "string" &&
    typeof element.source === "string"
  );
}

function shouldShowStyleRule(selected: SelectedElementContext | null, property: string, value: string) {
  const source = selected?.styleSources?.[property];
  const hasSource = Boolean(source?.file || source?.selector);
  if (!hasSource) return false;
  const normalizedValue = normalizeCssValue(value);
  if (!source?.file && isRuntimeDefaultStyle(property, normalizedValue)) {
    return false;
  }
  if (normalizedValue === "none" && isImplicitNoneStyle(property)) {
    return false;
  }
  return true;
}

function isRuntimeDefaultStyle(property: string, value: string) {
  const normalized = value.trim().toLowerCase();
  if (isZeroDefaultStyle(property) && isZeroCssValue(normalized)) return true;
  if (property === "background-color" && (normalized === "rgba(0, 0, 0, 0)" || normalized === "transparent")) return true;
  if (property === "background-image" && (normalized === "none" || normalized.includes("://127.0.0.1/@fs/"))) return true;
  if (property === "font-weight" && normalized === "400") return true;
  return false;
}

function isZeroDefaultStyle(property: string) {
  return ["left", "top", "right", "bottom", "margin", "padding", "border-radius"].includes(property);
}

function isZeroCssValue(value: string) {
  return /^(0|0px)(\s+(0|0px)){0,3}$/.test(value);
}

function isImplicitNoneStyle(property: string) {
  return ["background-image", "transform"].includes(property);
}

function selectedElementLabel(selected: SelectedElementContext) {
  const fallback = selected.tagName || "element";
  return leafSelector(selected.selector || "") || fallback;
}

function resolveSourceLocation(root: string, selected: SelectedElementContext | null, property: string) {
  const elementSource = selected?.elementSource || selected?.source;
  const styleSource = resolveStyleSource(selected, property);
  const file = styleSource?.file || elementSource?.file || "";
  if (!file) return null;
  const absoluteFile = file.startsWith("/") ? file : joinPath(root, file);
  const line = styleSource?.line || elementSource?.line;
  const column = styleSource?.column || elementSource?.column;
  const suffix = line ? `:${line}${column ? `:${column}` : ""}` : "";
  return {
    file: absoluteFile,
    line,
    column,
    url: `vscode://file/${absoluteFile}${suffix}`
  };
}

function resolveStyleSource(selected: SelectedElementContext | null, property: string) {
  return (
    selected?.styleSources?.[property] ||
    Object.values(selected?.styleSources || {}).find((source) => source?.file) ||
    null
  );
}

function firstEditableStyleProperty(selected: SelectedElementContext | null) {
  if (!selected) return "";
  const sourcedProperty = Object.entries(selected.styleSources || {}).find(([, source]) => source?.file)?.[0];
  if (sourcedProperty) return sourcedProperty;
  return Object.keys(selected.styles || {}).find((property) => selected.styles?.[property]) || "";
}

function updateSelectedStyle(
  selected: SelectedElementContext | null,
  property: string,
  value: string,
  file: string,
  source: SelectedElementContext["styleSources"] extends Record<string, infer T> | undefined ? T | null : never
) {
  if (!selected) return selected;
  return {
    ...selected,
    styles: {
      ...(selected.styles || {}),
      [property]: value
    },
    styleSources: {
      ...(selected.styleSources || {}),
      [property]: {
        ...(source || {}),
        file,
        value
      }
    }
  };
}

function updateSelectedImageSrc(selected: SelectedElementContext | null, src: string) {
  if (!selected) return selected;
  return {
    ...selected,
    attributes: {
      ...(selected.attributes || {}),
      src
    },
    sourceAttributes: {
      ...(selected.sourceAttributes || {}),
      src
    }
  };
}

function updateSelectedPreviewStyle(selected: SelectedElementContext | null, property: string, value: string) {
  if (!selected) return selected;
  return {
    ...selected,
    styles: {
      ...(selected.styles || {}),
      [property]: value
    },
    styleSources: {
      ...(selected.styleSources || {}),
      [property]: {
        ...(selected.styleSources?.[property] || {}),
        value
      }
    }
  };
}

function joinPath(root: string, file: string) {
  if (!root) return file;
  return `${root.replace(/\/$/, "")}/${file.replace(/^\//, "")}`;
}

function resolveElementSourceFile(selected: SelectedElementContext | null) {
  const file = selected?.elementSource?.file || selected?.source?.file || "";
  return file ? normalizeSourceFile(file) : "";
}

function parseDeviceWidth(search: string): DeviceWidth {
  const value = new URLSearchParams(search).get("width");
  if (value === "full") return "full";
  if (value === "750") return 750;
  if (value === "375") return 375;
  return window.matchMedia("(max-width: 879px)").matches ? "full" : 375;
}

function withEditorPassthroughParams(targetUrl: string, cacheBust = false) {
  if (!targetUrl || targetUrl === "about:blank") return targetUrl;
  try {
    const nextUrl = new URL(targetUrl, window.location.href);
    const editorParams = new URLSearchParams(window.location.search);
    for (const [key, value] of editorParams) {
      if (EDITOR_QUERY_KEYS.has(key)) continue;
      nextUrl.searchParams.set(key, value);
    }
    if (cacheBust) nextUrl.searchParams.set("__web_no_code_reload", String(Date.now()));
    return nextUrl.href;
  } catch {
    return targetUrl;
  }
}

function resolvePreviewNavigationUrl(value: string, currentUrl: string) {
  const nextUrl = value.trim();
  if (!nextUrl) return "";
  try {
    return new URL(nextUrl, currentUrl || window.location.href).href;
  } catch {
    return nextUrl;
  }
}

function normalizeTargetTitle(title: unknown) {
  return typeof title === "string" ? title.trim() : "";
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

function extractCssUrl(value: string) {
  const match = value.match(/url\((['"]?)(.*?)\1\)/);
  return match?.[2] || "";
}

function replaceCssUrl(value: string, nextUrl: string) {
  if (/url\((['"]?)(.*?)\1\)/.test(value)) {
    return value.replace(/url\((['"]?)(.*?)\1\)/, (_match, quote: string) => `url(${quote || "\""}${nextUrl}${quote || "\""})`);
  }
  return `url("${nextUrl}")`;
}

function isRemoteImageSource(src: string, baseUrl = "") {
  const trimmed = src.trim();
  if (!isHttpImageSource(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    if (isLoopbackHostname(url.hostname)) return false;
    if (baseUrl && url.origin === new URL(baseUrl, window.location.href).origin) return false;
  } catch {
    return true;
  }
  return true;
}

function isHttpImageSource(src: string) {
  return /^https?:\/\//i.test(src.trim());
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function resolveSelectedImageSource(selected: SelectedElementContext | null) {
  return resolveSelectedImageSources(selected)[0] || "";
}

function resolveSelectedImageSources(selected: SelectedElementContext | null) {
  const sourceSrc = selected?.sourceAttributes?.src;
  const sources = sourceSrc ? assetSearchCandidates(sourceSrc) : [];
  const attributeSrc = selected?.attributes?.src || "";
  return sortAssetCandidates([...sources, ...assetSearchCandidates(attributeSrc)]);
}

function resolveSelectedBackgroundSource(
  selected: SelectedElementContext | null,
  styleProperty: string,
  styleValue: string
) {
  return resolveSelectedBackgroundSources(selected, styleProperty, styleValue)[0] || "";
}

function resolveSelectedBackgroundSources(
  selected: SelectedElementContext | null,
  styleProperty: string,
  styleValue: string
) {
  const sourceValue = resolveStyleSource(selected, "background-image")?.value;
  const sourceUrl = extractCssUrl(sourceValue || "");
  const sources = sourceUrl ? assetSearchCandidates(sourceUrl) : [];
  const backgroundValue =
    styleProperty === "background-image" ? styleValue : selected?.styles?.["background-image"] || "";
  const backgroundUrl = extractCssUrl(backgroundValue);
  return sortAssetCandidates([...sources, ...assetSearchCandidates(backgroundUrl)]);
}

function resolveAssetSourceCandidate(src: string) {
  return sortAssetCandidates(assetSearchCandidates(src))[0] || "";
}

function sortAssetCandidates(candidates: string[]) {
  return Array.from(new Set(candidates))
    .filter(isProjectAssetCandidate)
    .sort(assetCandidatePriority);
}

function assetCandidatePriority(left: string, right: string) {
  return assetCandidateScore(left) - assetCandidateScore(right);
}

function assetCandidateScore(candidate: string) {
  if (candidate.startsWith("src/assets/")) return 0;
  if (candidate.startsWith("assets/")) return 1;
  if (candidate.startsWith("@/") || candidate.startsWith("~@/")) return 2;
  if (candidate.startsWith("/src/assets/")) return 3;
  if (candidate.startsWith("/assets/")) return 4;
  if (candidate.startsWith("/")) return 5;
  return 6;
}

function isProjectAssetCandidate(candidate: string) {
  if (!candidate) return false;
  if (/^(https?:)?\/\//.test(candidate) || candidate.startsWith("data:") || candidate.startsWith("blob:")) return false;
  return (
    candidate.startsWith("@/") ||
    candidate.startsWith("~@/") ||
    candidate.startsWith("assets/") ||
    candidate.startsWith("src/assets/") ||
    candidate.startsWith("/src/assets/") ||
    candidate.startsWith("/assets/") ||
    /^[./]*[^?#]+\.(png|jpe?g|webp|gif|svg)$/i.test(candidate)
  );
}

function assetSearchCandidates(src: string) {
  const candidates = new Set<string>();
  const add = (value: string) => {
    const normalized = value.trim();
    if (normalized) candidates.add(normalized);
  };

  add(src);
  try {
    const url = new URL(src, window.location.href);
    add(url.pathname);
    add(decodeURIComponent(url.pathname));
    add(url.pathname.replace(/^\/+/, ""));
    add(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    if (url.pathname.startsWith("/@fs/")) {
      add(url.pathname.replace(/^\/@fs\//, "/"));
      add(decodeURIComponent(url.pathname.replace(/^\/@fs\//, "/")));
    }
  } catch {
    // Keep the original string when URL parsing is not applicable.
  }

  const path = src.split(/[?#]/)[0];
  add(path);
  add(path.replace(/^\//, ""));
  add(path.replace(/^\/?src\//, "src/"));
  add(path.replace(/^\/?src\//, ""));
  const filename = path.split("/").filter(Boolean).at(-1);
  if (filename) {
    add(`@/assets/${filename}`);
    add(`src/assets/${filename}`);
    add(`assets/${filename}`);
  }

  return Array.from(candidates);
}

function resolveRuleStyleFile(selected: SelectedElementContext | null, property: string) {
  const sourceFile =
    selected?.styleSources?.[property]?.file ||
    Object.values(selected?.styleSources || {}).find((source) => source?.file)?.file ||
    selected?.elementSource?.file ||
    selected?.source?.file ||
    "";
  return sourceFile ? normalizeSourceFile(sourceFile) : "";
}

function resolvePositionStyleFile(selected: SelectedElementContext | null, property: string) {
  const elementFile = selected?.elementSource?.file || selected?.source?.file || "";
  const propertyFile = selected?.styleSources?.[property]?.file || "";
  if (propertyFile && (!elementFile || sameSourceFile(propertyFile, elementFile))) {
    return normalizeSourceFile(propertyFile);
  }
  if (elementFile) return normalizeSourceFile(elementFile);
  const sourceFile =
    Object.values(selected?.styleSources || {}).find((source) => source?.file)?.file ||
    "";
  return sourceFile ? normalizeSourceFile(sourceFile) : "";
}

function sameSourceFile(left: string, right: string) {
  return normalizeSourceFile(left) === normalizeSourceFile(right);
}

function normalizeSourceFile(file: string) {
  if (file.startsWith("/")) return file;
  return file.replace(/^\/?src\//, "src/");
}

function formatSourceFileForDisplay(file: string, workspaceRoot: string) {
  const normalizedFile = file.replace(/\\/g, "/");
  const normalizedRoot = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedFile || !normalizedRoot) return normalizedFile;
  if (normalizedFile === normalizedRoot) return normalizedFile.split("/").at(-1) || normalizedFile;
  return normalizedFile.startsWith(`${normalizedRoot}/`)
    ? normalizedFile.slice(normalizedRoot.length + 1)
    : normalizedFile;
}

function normalizeCssValue(value: string) {
  return value.replace(/-?\d+\.\d+px/g, (match) => `${Math.round(Number(match.slice(0, -2)))}px`);
}

function formatElapsedTime(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function codexActivityLabel(elapsedMs: number, hasContent: boolean) {
  if (hasContent) return "Working";
  if (elapsedMs < 8000) return "Starting Codex";
  if (elapsedMs < 30000) return "Codex is thinking";
  return "Still working";
}

function visibleDisplayValue(value = "") {
  const normalized = value.trim();
  return normalized && normalized !== "none" ? normalized : "block";
}

function stepCssNumericValue(value: string, direction: 1 | -1, step: number) {
  const match = value.match(/-?\d*\.?\d+/);
  if (!match || match.index == null) return "";
  const current = Number(match[0]);
  if (!Number.isFinite(current)) return "";
  const decimals = decimalPlaces(match[0], step);
  const next = roundTo(current + direction * step, decimals);
  return `${value.slice(0, match.index)}${formatSteppedNumber(next, decimals)}${value.slice(match.index + match[0].length)}`;
}

function decimalPlaces(value: string, step: number) {
  const valueDecimals = value.includes(".") ? value.split(".")[1]?.length || 0 : 0;
  const stepText = String(step);
  const stepDecimals = stepText.includes(".") ? stepText.split(".")[1]?.length || 0 : 0;
  return Math.max(valueDecimals, stepDecimals);
}

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatSteppedNumber(value: number, decimals: number) {
  return decimals > 0 ? value.toFixed(decimals).replace(/\.?0+$/, "") : String(value);
}

function formatUserMessage(input: string, attachmentCount: number) {
  const text = input.trim();
  if (!attachmentCount) return text;
  const suffix = `[${attachmentCount} image${attachmentCount === 1 ? "" : "s"} attached]`;
  return text ? `${text}\n\n${suffix}` : suffix;
}

function isActiveCodexTurnError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already has an active Codex turn");
}

function createClientId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function imageFilesFromClipboard(data: DataTransfer) {
  const files = Array.from(data.files).filter((file) => file.type.startsWith("image/"));
  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  return dedupeImageFiles([...files, ...itemFiles]);
}

async function imageFilesFromAsyncClipboard() {
  if (!navigator.clipboard || !("read" in navigator.clipboard)) {
    throw new Error("navigator.clipboard.read is unavailable");
  }
  const items = await navigator.clipboard.read();
  const files: File[] = [];

  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    files.push(new File([blob], `pasted-image-${Date.now()}.${extensionFromMimeType(imageType)}`, { type: imageType }));
  }

  return dedupeImageFiles(files);
}

function clipboardSummary(data: DataTransfer) {
  const fileTypes = Array.from(data.files).map((file) => file.type || file.name || "file");
  const itemTypes = Array.from(data.items).map((item) => `${item.kind}:${item.type || "unknown"}`);
  const types = Array.from(data.types || []);
  return [
    `files=${data.files.length}${fileTypes.length ? `(${fileTypes.join(",")})` : ""}`,
    `items=${data.items.length}${itemTypes.length ? `(${itemTypes.join(",")})` : ""}`,
    `types=${types.length ? types.join(",") : "none"}`
  ].join(" ");
}

function fileFromDataUrl(dataUrl: string, name: string, type: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  try {
    const mimeType = match[1] || type || "image/png";
    const payload = match[3] || "";
    const binary = match[2] ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], name || `pasted-image-${Date.now()}.${extensionFromMimeType(mimeType)}`, { type: mimeType });
  } catch {
    return null;
  }
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function imageSignature(dataUrl: string) {
  return dataUrl.slice(0, 96) + ":" + dataUrl.length + ":" + dataUrl.slice(-96);
}

function dedupeImageFiles(files: File[]) {
  const unique = new Map<string, File>();
  for (const file of files) {
    const image = normalizePastedImageFile(file);
    unique.set(`${image.name}:${image.size}:${image.type}`, image);
  }
  return Array.from(unique.values());
}

function normalizePastedImageFile(file: File) {
  if (file.name) return file;
  const extension = extensionFromMimeType(file.type);
  return new File([file], `pasted-image-${Date.now()}.${extension}`, { type: file.type || "image/png" });
}

function extensionFromMimeType(type: string) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/svg+xml") return "svg";
  return type.split("/")[1] || "png";
}

function isCssColor(value: string) {
  if (!value || value.includes("gradient(") || value.includes("url(")) return false;
  const option = new Option();
  option.style.color = "";
  option.style.color = value;
  return Boolean(option.style.color);
}

function selectorCandidates(selected: SelectedElementContext, property?: string) {
  const selectors = new Set<string>();
  const sourceSelector = property ? selected.styleSources?.[property]?.selector : "";
  const contextSelector = selected.contextSelector || "";
  const full = selected.selector || "";
  const leaf = full.split(" > ").at(-1) || full;
  const id = selected.attributes?.id;
  const className = selected.attributes?.class || "";
  const classes = className.split(/\s+/).filter(Boolean);

  for (const selector of simplifiedAncestorLeafSelectors(full)) selectors.add(selector);
  for (const selector of contextSelectorVariants(contextSelector)) selectors.add(selector);
  if (sourceSelector && sourceSelector !== "style") {
    selectors.add(sourceSelector);
    const normalizedSourceSelector = normalizeVueScopedSelector(sourceSelector);
    if (normalizedSourceSelector) selectors.add(normalizedSourceSelector);
  }
  if (id) selectors.add(`#${cssEscape(id)}`);
  if (classes.length) selectors.add(`.${classes.map(cssEscape).join(".")}`);
  for (const classItem of classes) selectors.add(`.${cssEscape(classItem)}`);
  if (leaf) selectors.add(leaf);
  if (full) selectors.add(full);

  return Array.from(selectors);
}

function simplifiedAncestorLeafSelectors(selector: string) {
  if (!selector) return [];
  const parts = selector.split(" > ").filter(Boolean);
  const classParts = parts.map((part) => firstClassSelector(part)).filter(Boolean);
  const leafClass = classParts.at(-1) || "";
  if (classParts.length < 2 || !leafClass) return [];
  const ancestorClasses = classParts.slice(0, -1);
  const candidates = new Set<string>();

  for (let start = 0; start < ancestorClasses.length; start += 1) {
    candidates.add([...ancestorClasses.slice(start), leafClass].join(" "));
  }

  for (const ancestorClass of [...ancestorClasses].reverse()) {
    candidates.add(`${ancestorClass} ${leafClass}`);
  }

  return Array.from(candidates);
}

function firstClassSelector(selector: string) {
  const className = selector.match(/\.([A-Za-z0-9_-]+)/)?.[1];
  return className ? `.${cssEscape(className)}` : "";
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function normalizeVueScopedSelector(selector: string) {
  return selector.replace(/\[data-v-[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
}

function contextSelectorVariants(selector: string) {
  if (!selector) return [];
  const variants = new Set<string>([selector]);
  const parts = selector.trim().split(/\s+/);
  if (parts.length >= 2) {
    const child = parts.at(-1) || "";
    const parent = parts.slice(0, -1).join(" ");
    for (const className of parent.match(/\.[A-Za-z0-9_-]+/g) || []) {
      variants.add(`${className} ${child}`);
    }
  }
  return Array.from(variants);
}

function formatAgentsApiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("API route not found") || message.includes("/api/workspace/agents")) {
    return "Restart Web No Code to enable AGENTS.md sync";
  }
  return message.length > 100 ? `${message.slice(0, 97)}...` : message;
}

function getDocumentStats(content: string) {
  return {
    lines: content ? content.split(/\r?\n/).length : 0,
    characters: content.length
  };
}

function readCodexSandboxStorage(): CodexSandbox {
  try {
    return window.localStorage.getItem(CODEX_SANDBOX_STORAGE_KEY) === "danger-full-access"
      ? "danger-full-access"
      : window.localStorage.getItem(CODEX_SANDBOX_STORAGE_KEY) === "workspace-write"
        ? "workspace-write"
        : "danger-full-access";
  } catch {
    return "danger-full-access";
  }
}

function writeCodexSandboxStorage(value: CodexSandbox) {
  try {
    window.localStorage.setItem(CODEX_SANDBOX_STORAGE_KEY, value);
  } catch {
    // Local storage can be unavailable in locked-down browser contexts.
  }
}

function readCodexWorkspaceModeStorage(): CodexWorkspaceMode {
  try {
    return window.localStorage.getItem(CODEX_WORKSPACE_MODE_STORAGE_KEY) === "shadow" ? "shadow" : "direct";
  } catch {
    return "direct";
  }
}

function writeCodexWorkspaceModeStorage(value: CodexWorkspaceMode) {
  try {
    window.localStorage.setItem(CODEX_WORKSPACE_MODE_STORAGE_KEY, value);
  } catch {
    // Local storage can be unavailable in locked-down browser contexts.
  }
}

function readCodexModelStorage() {
  try {
    return window.localStorage.getItem(CODEX_MODEL_STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

function writeCodexModelStorage(value: string) {
  try {
    if (value) {
      window.localStorage.setItem(CODEX_MODEL_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(CODEX_MODEL_STORAGE_KEY);
    }
  } catch {
    // Local storage can be unavailable in locked-down browser contexts.
  }
}

function readCodexReasoningEffortStorage() {
  try {
    return window.localStorage.getItem(CODEX_REASONING_EFFORT_STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

function writeCodexReasoningEffortStorage(value: string) {
  try {
    if (value) {
      window.localStorage.setItem(CODEX_REASONING_EFFORT_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(CODEX_REASONING_EFFORT_STORAGE_KEY);
    }
  } catch {
    // Local storage can be unavailable in locked-down browser contexts.
  }
}

function formatReasoningEffort(value: string) {
  const labels: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Maximum",
    ultra: "Ultra"
  };
  return labels[value] || value || "Default";
}

function readCodexSessionStorage(workspaceRoot: string): CodexSessionSnapshot {
  try {
    const raw = window.sessionStorage.getItem(codexSessionStorageKey(workspaceRoot));
    if (!raw) return emptyCodexSessionSnapshot();
    const parsed = JSON.parse(raw) as Partial<CodexSessionSnapshot>;
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map(normalizeStoredCodexTask).filter((task): task is CodexTask => Boolean(task)).slice(-MAX_CODEX_TASKS)
      : [];
    if (tasks.length) {
      chatId = Math.max(chatId, ...tasks.flatMap((task) => task.chatMessages.map((message) => message.id)), 0);
      const activeTaskId =
        typeof parsed.activeTaskId === "string" && tasks.some((task) => task.id === parsed.activeTaskId)
          ? parsed.activeTaskId
          : tasks[0].id;
      return { activeTaskId, tasks };
    }
    const legacy = parsed as Partial<{ threadId: string; codexInput: string; chatMessages: ChatMessage[] }>;
    const chatMessages = Array.isArray(legacy.chatMessages)
      ? legacy.chatMessages.filter(isStoredChatMessage).slice(-31)
      : [];
    chatId = Math.max(chatId, ...chatMessages.map((message) => message.id), 0);
    const task = createEmptyCodexTask({
      threadId: typeof legacy.threadId === "string" ? legacy.threadId : "",
      input: typeof legacy.codexInput === "string" ? legacy.codexInput : "",
      chatMessages,
      title: summarizeCodexTaskTitle(chatMessages.find((message) => message.role === "user")?.content || "") || "Task 1"
    });
    return {
      activeTaskId: task.id,
      tasks: [task]
    };
  } catch {
    return emptyCodexSessionSnapshot();
  }
}

function writeCodexSessionStorage(workspaceRoot: string, snapshot: CodexSessionSnapshot) {
  try {
    window.sessionStorage.setItem(
      codexSessionStorageKey(workspaceRoot),
      JSON.stringify({
        activeTaskId: snapshot.activeTaskId,
        tasks: snapshot.tasks.slice(-MAX_CODEX_TASKS).map((task) => ({
          ...task,
          attachments: task.attachments.slice(-12),
          chatMessages: task.chatMessages.slice(-31)
        }))
      })
    );
  } catch {
    // Session storage can be unavailable in locked-down browser contexts.
  }
}

function codexSessionStorageKey(workspaceRoot: string) {
  const normalized = normalizeCodexWorkspaceRoot(workspaceRoot);
  return normalized ? `${CODEX_SESSION_STORAGE_KEY}:${encodeStorageKeySegment(normalized)}` : CODEX_SESSION_STORAGE_KEY;
}

function readEditorTargetRootStorage() {
  try {
    return window.sessionStorage.getItem(EDITOR_TARGET_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function writeEditorTargetRootStorage(root: string) {
  try {
    window.sessionStorage.setItem(EDITOR_TARGET_STORAGE_KEY, root);
  } catch {
    // Session storage can be unavailable in locked-down browser contexts.
  }
}

function selectRegisteredTarget(targets: RegisteredTarget[], targetRoot: string) {
  if (!targetRoot) return targets[0];
  return targets.find((target) => target.root === targetRoot) || targets[0];
}

function normalizeCodexWorkspaceRoot(workspaceRoot: string) {
  return workspaceRoot.trim().replace(/\/+$/, "");
}

function encodeStorageKeySegment(value: string) {
  try {
    return btoa(encodeURIComponent(value)).replace(/=+$/, "");
  } catch {
    return encodeURIComponent(value);
  }
}

function emptyCodexSessionSnapshot(): CodexSessionSnapshot {
  const task = createEmptyCodexTask();
  return {
    activeTaskId: task.id,
    tasks: [task]
  };
}

function createEmptyCodexTask(init: Partial<Omit<CodexTask, "id" | "createdAt" | "updatedAt">> = {}): CodexTask {
  const now = Date.now();
  return {
    id: createClientId(),
    title: init.title || "New task",
    threadId: init.threadId || "",
    input: init.input || "",
    attachments: init.attachments || [],
    chatMessages: init.chatMessages || [],
    busy: Boolean(init.busy),
    turnStartedAt: init.turnStartedAt,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeStoredCodexTask(value: unknown): CodexTask | null {
  if (!value || typeof value !== "object") return null;
  const task = value as Partial<CodexTask>;
  if (typeof task.id !== "string") return null;
  const chatMessages = Array.isArray(task.chatMessages)
    ? task.chatMessages.filter(isStoredChatMessage).slice(-31)
    : [];
  const attachments = Array.isArray(task.attachments)
    ? task.attachments.filter(isStoredCodexAttachment).slice(-12)
    : [];
  return {
    id: task.id,
    title: typeof task.title === "string" && task.title.trim() ? task.title : "New task",
    threadId: typeof task.threadId === "string" ? task.threadId : "",
    input: typeof task.input === "string" ? task.input : "",
    attachments,
    chatMessages,
    busy: Boolean(task.busy && task.threadId),
    turnStartedAt: typeof task.turnStartedAt === "number" && Number.isFinite(task.turnStartedAt)
      ? task.turnStartedAt
      : undefined,
    createdAt: typeof task.createdAt === "number" ? task.createdAt : Date.now(),
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : Date.now()
  };
}

function isStoredCodexAttachment(value: unknown): value is CodexAttachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Partial<CodexAttachment>;
  return (
    typeof attachment.id === "string" &&
    typeof attachment.name === "string" &&
    typeof attachment.previewUrl === "string" &&
    typeof attachment.path === "string" &&
    typeof attachment.signature === "string"
  );
}

function summarizeCodexTaskTitle(input: string) {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > 32 ? `${normalized.slice(0, 32)}...` : normalized;
}

function isStoredChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return (
    typeof message.id === "number" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}
