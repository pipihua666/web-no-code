import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Plugin, ViteDevServer } from "vite";
import {
  WebNoCodePreviewWidth,
  resolveSourceFileHint,
  resolveViteSourceFile,
  webNoCodeInspector
} from "./index";

test("exports the supported preview widths", () => {
  assert.equal(WebNoCodePreviewWidth.Width375, 375);
  assert.equal(WebNoCodePreviewWidth.Width750, 750);
  assert.equal(WebNoCodePreviewWidth.Full, "full");
});

test("returns no Vite plugins when disabled", () => {
  assert.deepEqual(webNoCodeInspector({ enabled: false }), []);
});

test("omits Vue inspector support when disabled independently", () => {
  const plugins = webNoCodeInspector({ vueInspector: false });
  assert.equal(plugins.length, 1);
  assert.equal((plugins[0] as Plugin).name, "web-no-code-inspector");
});

test("injects the runtime without overriding the browser user agent", () => {
  const html = transformHtml({ vueInspector: false }, "<html><head></head></html>");
  assert.match(html, /inspector-runtime/);
  assert.match(html, /inspector:list-siblings/);
  assert.match(html, /sibling-options/);
  assert.doesNotMatch(html, /navigator\.userAgent|iPhone/);
});

test("resolves a root-relative Vite URL produced from a relative component import", () => {
  const root = mkdtempSync(join(tmpdir(), "web-no-code-source-"));
  const sourceFile = join(root, "components/mobile/Preview/index.vue");
  mkdirSync(join(root, "components/mobile/Preview"), { recursive: true });
  writeFileSync(sourceFile, "<template><div /></template>");

  try {
    assert.equal(resolveSourceFileHint(root, "/components/mobile/Preview/index.vue"), sourceFile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses Vite's module graph for a source file outside the workspace root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "web-no-code-source-"));
  const root = join(parent, "activity");
  const sourceFile = join(parent, "components/mobile/Preview/index.vue");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(parent, "components/mobile/Preview"), { recursive: true });
  writeFileSync(sourceFile, "<template><div /></template>");
  const server = {
    moduleGraph: {
      getModuleByUrl: async () => ({ file: sourceFile }),
      getModuleById: () => undefined
    },
    pluginContainer: {
      resolveId: async () => null
    }
  } as unknown as Pick<ViteDevServer, "moduleGraph" | "pluginContainer">;

  try {
    assert.equal(await resolveViteSourceFile(server, "/components/mobile/Preview/index.vue"), sourceFile);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("does not accept an external path that is absent from Vite's module graph", async () => {
  const sourceFile = join(tmpdir(), "not-a-vite-module.vue");
  const server = {
    moduleGraph: {
      getModuleByUrl: async () => undefined,
      getModuleById: () => undefined
    },
    pluginContainer: {
      resolveId: async () => ({ id: sourceFile })
    }
  } as unknown as Pick<ViteDevServer, "moduleGraph" | "pluginContainer">;

  assert.equal(await resolveViteSourceFile(server, sourceFile), "");
});

function transformHtml(
  options: Parameters<typeof webNoCodeInspector>[0],
  html: string
) {
  const plugin = webNoCodeInspector(options)[0] as Plugin;
  assert.equal(typeof plugin.transformIndexHtml, "function");
  return (plugin.transformIndexHtml as (html: string) => string)(html);
}
