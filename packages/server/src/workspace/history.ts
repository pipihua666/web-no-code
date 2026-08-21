import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeResolve } from "../codex/utils";

type HistoryFile = {
  file: string;
  before: Buffer;
  after: Buffer;
  beforeExists: boolean;
  afterExists: boolean;
};

type HistoryEntry = {
  files: HistoryFile[];
  createdAt: number;
  summary: string;
};

type WorkspaceHistory = {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
};

const MAX_HISTORY_ENTRIES = 100;
const histories = new Map<string, WorkspaceHistory>();

export type HistoryFileSnapshot = {
  file: string;
  content: Buffer;
  exists: boolean;
};

export type WorkspaceHistoryAction = {
  summary: string;
  files: string[];
};

export async function captureWorkspaceFiles(root: string, files: string[]) {
  return Promise.all(files.map(async (file) => {
    const path = safeResolve(root, file);
    const exists = existsSync(path);
    return {
      file,
      content: exists ? await readFile(path) : Buffer.alloc(0),
      exists
    } satisfies HistoryFileSnapshot;
  }));
}

export function recordWorkspaceHistory(
  root: string,
  before: HistoryFileSnapshot[],
  after: HistoryFileSnapshot[],
  summary = "Workspace change"
) {
  const afterByFile = new Map(after.map((snapshot) => [snapshot.file, snapshot]));
  const files = before
    .map((beforeSnapshot) => {
      const afterSnapshot = afterByFile.get(beforeSnapshot.file);
      if (!afterSnapshot || beforeSnapshot.exists === afterSnapshot.exists && beforeSnapshot.content.equals(afterSnapshot.content)) {
        return null;
      }
      return {
        file: beforeSnapshot.file,
        before: beforeSnapshot.content,
        after: afterSnapshot.content,
        beforeExists: beforeSnapshot.exists,
        afterExists: afterSnapshot.exists
      } satisfies HistoryFile;
    })
    .filter((file): file is HistoryFile => Boolean(file));
  if (!files.length) return;
  const history = histories.get(root) || { undo: [], redo: [] };
  history.undo.push({ files, createdAt: Date.now(), summary });
  if (history.undo.length > MAX_HISTORY_ENTRIES) history.undo.shift();
  history.redo = [];
  histories.set(root, history);
}

export function getWorkspaceHistoryState(root: string) {
  const history = histories.get(root);
  return {
    canUndo: Boolean(history?.undo.length),
    canRedo: Boolean(history?.redo.length),
    undo: describeHistoryEntry(history?.undo[history.undo.length - 1]),
    redo: describeHistoryEntry(history?.redo[history.redo.length - 1])
  };
}

export async function undoWorkspaceHistory(root: string) {
  return moveHistory(root, "undo");
}

export async function redoWorkspaceHistory(root: string) {
  return moveHistory(root, "redo");
}

async function moveHistory(root: string, direction: "undo" | "redo") {
  const history = histories.get(root) || { undo: [], redo: [] };
  const source = direction === "undo" ? history.undo : history.redo;
  const destination = direction === "undo" ? history.redo : history.undo;
  const entry = source.pop();
  if (!entry) return { changedFiles: [], ...getWorkspaceHistoryState(root) };
  const snapshots = direction === "undo"
    ? entry.files.map((file) => ({ file: file.file, content: file.before, exists: file.beforeExists }))
    : entry.files.map((file) => ({ file: file.file, content: file.after, exists: file.afterExists }));
  await writeWorkspaceFiles(root, snapshots);
  destination.push(entry);
  histories.set(root, history);
  return { changedFiles: entry.files.map((file) => file.file), ...getWorkspaceHistoryState(root) };
}

function describeHistoryEntry(entry: HistoryEntry | undefined): WorkspaceHistoryAction | null {
  if (!entry) return null;
  return {
    summary: entry.summary,
    files: entry.files.map((file) => file.file)
  };
}

async function writeWorkspaceFiles(root: string, files: HistoryFileSnapshot[]) {
  for (const file of files) {
    const path = safeResolve(root, file.file);
    if (!file.exists) {
      await rm(path, { force: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
}
