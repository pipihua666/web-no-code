import { spawn } from "node:child_process";
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter } from "node:path";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export function safeResolve(root: string, nextPath: string) {
  const normalizedRoot = normalize(resolve(root));
  const resolved = isAbsolute(nextPath)
    ? normalize(nextPath)
    : normalize(resolve(normalizedRoot, nextPath));

  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Path escapes workspace root: ${nextPath}`);
  }

  return resolved;
}

export async function commandExists(command: string) {
  return Boolean(await resolveCommand(command));
}

export async function resolveCommand(command: string) {
  if (command === "codex" && process.env.CODEX_BIN) {
    return process.env.CODEX_BIN;
  }

  if (isAbsolute(command) && (await pathExists(command))) {
    return command;
  }

  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const pathItems = (process.env.PATH || "").split(delimiter).filter(Boolean);

  for (const item of pathItems) {
    for (const extension of extensions) {
      const candidate = join(item, `${command}${extension}`);
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

export async function pathExists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    input?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
) {
  return await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer =
      options.timeoutMs &&
      setTimeout(() => {
        settled = true;
        child.kill("SIGTERM");
        resolvePromise({ code: null, stdout, stderr, timedOut: true });
      }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ code: 1, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut: false });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

export async function ensureFile(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function readText(path: string) {
  return await readFile(path, "utf8");
}
