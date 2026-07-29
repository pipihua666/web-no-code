#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const releaseType = process.argv[2];
const validReleaseTypes = new Set(["patch", "minor", "major", "current"]);

if (!validReleaseTypes.has(releaseType)) {
  console.error("Usage: pnpm release | pnpm release:<patch|minor|major>");
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = resolve(repoRoot, "packages/vite-inspector-plugin");
const packageFiles = [
  "package.json",
  "packages/server/package.json",
  "packages/editor/package.json",
  "packages/vite-inspector-plugin/package.json"
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8"
  });
}

function statusLines() {
  return run("git", ["status", "--porcelain"], { capture: true }).split("\n").filter(Boolean);
}

function ensureNoStagedChanges() {
  const staged = statusLines().filter((line) => line[0] !== " " && line[0] !== "?");
  if (staged.length) {
    console.error("Release aborted: staged changes are not allowed.");
    console.error(staged.join("\n"));
    process.exit(1);
  }
}

function ensureCleanWorktree() {
  const status = statusLines();
  if (status.length) {
    console.error("Release aborted: working tree is not clean.");
    console.error(status.join("\n"));
    process.exit(1);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
}

function writeJson(path, value) {
  writeFileSync(resolve(repoRoot, path), `${JSON.stringify(value, null, 2)}\n`);
}

function bumpVersion(version, type) {
  const parts = version.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Unsupported semver version: ${version}`);
  }
  const [major, minor, patch] = parts;
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function ensureNpmLoggedIn() {
  try {
    run("npm", ["whoami"], { capture: true });
  } catch {
    console.error("Release aborted: npm is not logged in. Run `npm login` first.");
    process.exit(1);
  }
}

function ensureNpmVersionAvailable(name, version) {
  try {
    const publishedVersion = run("npm", ["view", `${name}@${version}`, "version"], { capture: true }).trim();
    if (publishedVersion === version) {
      console.error(`Release aborted: ${name}@${version} already exists on npm.`);
      process.exit(1);
    }
  } catch {
    // npm view exits non-zero when the version does not exist, which is what we need.
  }
}

const rootPackage = readJson("package.json");

if (releaseType === "current") {
  ensureNoStagedChanges();
} else {
  ensureCleanWorktree();
}

const nextVersion = releaseType === "current" ? rootPackage.version : bumpVersion(rootPackage.version, releaseType);
const tag = `v${nextVersion}`;
let reuseExistingTag = false;

if (run("git", ["tag", "--list", tag], { capture: true }).trim()) {
  const tagCommit = run("git", ["rev-list", "-n", "1", tag], { capture: true }).trim();
  const headCommit = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
  if (releaseType === "current" && tagCommit === headCommit) {
    reuseExistingTag = true;
    console.log(`Reusing existing local tag ${tag} at HEAD.`);
  } else {
    console.error(`Release aborted: tag ${tag} already exists and does not match the current release target.`);
    process.exit(1);
  }
}

if (releaseType !== "current") {
  for (const file of packageFiles) {
    const packageJson = readJson(file);
    packageJson.version = nextVersion;
    writeJson(file, packageJson);
  }
}

const pluginPackage = readJson("packages/vite-inspector-plugin/package.json");
if (pluginPackage.version !== nextVersion) {
  console.error(`Release aborted: plugin version ${pluginPackage.version} does not match root version ${nextVersion}.`);
  process.exit(1);
}

ensureNpmLoggedIn();
ensureNpmVersionAvailable(pluginPackage.name, nextVersion);

run("pnpm", ["typecheck"]);
run("pnpm", ["build"], { cwd: pluginDir });
run("npm", ["publish", "--access", "public"], { cwd: pluginDir });

if (!reuseExistingTag) {
  run("git", ["add", ...packageFiles, "scripts/release-npm.mjs"]);
  run("git", ["commit", "-m", `chore: release ${tag}`]);
  run("git", ["tag", tag]);
}

console.log(
  `Published ${pluginPackage.name}@${nextVersion} to npm and ${reuseExistingTag ? "reused" : "created"} local tag ${tag}.`
);
