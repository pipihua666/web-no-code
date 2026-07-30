# @web-no-code/vite-inspector-plugin

Select an element in a running Vite page, locate its source, and edit the project directly.

## What It Solves

Browser DevTools show the rendered DOM and computed styles, but source edits need more context:

- CSS changes need the original file, selector, and declaration.
- Codex needs to know which component and styles belong to “this element.”
- Image replacement needs the original filename and real asset location, not only a transformed browser URL.

This plugin connects those runtime elements to the local workspace. It injects an inspector into the Vite page, starts the Web No Code editor, and registers the target URL, project root, source maps, and aliases needed for source lookup.

The result is one page-to-source workflow for editing CSS, sending selected-element context to Codex, and replacing local image files.

## Install

```bash
pnpm add -D @web-no-code/vite-inspector-plugin
```

Vite 5 or newer is required.

## Configure Vite

```js
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { webNoCodeInspector } from "@web-no-code/vite-inspector-plugin";

export default defineConfig({
  plugins: [
    vue(),
    webNoCodeInspector()
  ]
});
```

Start the target project normally:

```bash
pnpm dev
```

Web No Code opens automatically at `http://127.0.0.1:4317` with the current Vite page loaded.

The plugin uses `apply: "serve"`. It does not run during `vite build` and does not add inspector code to production output.

## Workflows

### Edit CSS

Enable element selection, click an element in the preview, and edit a located declaration in CSS Rules. Press `Enter` or blur the field to write the change back to its source file.

### Edit With Codex

Select an element and send a prompt with its context attached. Web No Code gives Codex the selector, source locations, styles, and page context. Direct workspace mode edits the target project in place; optional shadow mode runs in a temporary workspace and applies the resulting diff back to the project.

A working local Codex CLI is required only for this workflow.

### Replace Images

Select an `<img>` or an element with `background-image`, then choose a replacement from the image preview. Local paths, aliases such as `@/assets/...`, Vite `/@fs/...` URLs, and assets served from the target dev server are resolved back to a workspace file. External `http(s)` images are edited as source URLs instead.

## Options

```js
import { WebNoCodePreviewWidth } from "@web-no-code/vite-inspector-plugin";

webNoCodeInspector({
  enabled: true,
  vueInspector: true,
  autoStart: true,
  open: true,
  width: WebNoCodePreviewWidth.Width375,
  serverPort: 4317,
  workspaceRoot: process.cwd()
});
```

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Enable the plugin; `false` disables injection and editor startup |
| `vueInspector` | `true` | Enable Vue component source lookup support |
| `autoStart` | `true` | Start the local editor server automatically |
| `open` | `true` | Open the editor after startup |
| `width` | `WebNoCodePreviewWidth.Width375` | Initial target preview width: `Width375`, `Width750`, or `Full` |
| `serverPort` | `4317` | Preferred editor server port |
| `serverUrl` | - | Connect to an existing Web No Code server |
| `workspaceRoot` | `process.cwd()` | Root directory available to source operations |
| `cli` | bundled CLI | Override the server command for advanced integrations |

## Safety And Scope

- The inspector is development-only.
- Edits are written to the real local workspace; keep the project under version control.
- Cross-origin stylesheets, runtime-generated rules, or missing source maps may not map back to an original declaration.

Repository documentation and contribution instructions are available in the [Web No Code repository](https://github.com/pipihua666/web-no-code).
