#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const command = process.argv[2] || "serve";

void main();

async function main() {
  if (command !== "serve") {
    console.warn(`web-no-code only runs in Vite dev server mode. Ignored command: ${command}`);
    return;
  }
  const distRoot = dirname(process.argv[1] || "");
  process.env.WEB_NO_CODE_EDITOR_DIST ||= resolve(distRoot, "editor");
  await import(pathToFileURL(resolve(distRoot, "server-entry.js")).href);
}
