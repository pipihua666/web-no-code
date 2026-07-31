# Web No Code

**直接在正在运行的 Vite 页面上选择元素、找到源码并完成修改。**

[English README](./README.md)

## 为什么需要它

页面在浏览器里看起来很直观，但想修改一个按钮、一条样式或一张图片时，经常不知道应该打开哪个文件。浏览器开发者工具展示的是运行结果，真正需要修改的代码可能在 Vue 组件、React 组件、CSS 文件或本地图片中。

Web No Code 把页面和这些源码连接起来。选中元素后，你可以直接修改 CSS、让 Codex 根据元素上下文改代码、替换图片，或者快速打开相关源文件。

## 它是什么

`@web-no-code/vite-inspector-plugin` 是一个用于 Vite 开发项目的可视化源码编辑插件。它只在 Vite 开发服务器中运行，不会进入生产构建。

接入插件并启动业务项目后，它会自动打开一个本地编辑器，并在其中加载当前页面。

![Web No Code 可视化编辑器，包含元素选择、Codex 编辑和 CSS 规则面板](./image.png)

## 快速开始

### 1. 安装

业务项目需要使用 Vite 5 或更高版本。

```bash
pnpm add -D @web-no-code/vite-inspector-plugin
```

### 2. 配置 Vite

```js
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { webNoCodeInspector } from "@web-no-code/vite-inspector-plugin";

export default defineConfig({
  plugins: [vue(), webNoCodeInspector()],
  css: {
    devSourcemap: true
  }
});
```

React 项目保留已有的 React 插件，并在旁边加入 `webNoCodeInspector()` 即可。

`css.devSourcemap` 可以帮助 Web No Code 准确定位 Vue 样式、SCSS、Less、PostCSS 和嵌套 CSS 的源码位置。不开启时，简单样式仍可能正常定位，但准确度会降低。这个配置只影响开发环境。

插件本身只在开发环境运行，不需要额外判断 `command === "serve"`。

### 3. 启动业务项目

```bash
pnpm dev
```

插件默认在 `http://127.0.0.1:4317` 启动 Web No Code 并自动打开。修改会直接写入业务项目，建议使用前先通过 Git 管理代码。

## 从页面修改源码

为了更快地定位源码，建议为可编辑元素使用稳定且唯一的 CSS selector，并尽量避免过深的嵌套 CSS。如果 Web No Code 无法可靠地找到原始声明，可以按 `Ctrl+S` 打开当前能识别到的最接近的源文件，再手动修改。

### 选择元素

1. 点击顶部工具栏中的元素选择按钮。
2. 在预览页面中点击要修改的元素。
3. 编辑器会显示它的源码和样式信息。

### 修改 CSS

在 CSS Rules 面板修改属性值，然后按 `Enter` 或让输入框失焦即可保存。

修改数值时，可以使用 `Arrow Up` 和 `Arrow Down`。按住 `Shift` 时步长为 `10`，按住 `Alt` 时步长为 `0.1`。对于绝对定位或固定定位元素，也可以直接拖动。

### 让 Codex 修改代码

选中元素，在 Codex 输入区保留它的上下文，然后描述需要完成的修改。Web No Code 会把相关 selector、组件、样式来源和页面信息一起发送给 Codex。

该功能需要本机安装 Codex CLI。如果 `codex` 不在 `PATH` 中，可以设置 `CODEX_BIN`：

```bash
CODEX_BIN=/absolute/path/to/codex pnpm --dir packages/server dev
```

### 替换图片

选中 `<img>` 或带有 `background-image` 的元素，然后点击右侧面板中的图片预览。

- 本地图片：选择新的图片文件。
- 远程 `http(s)` 图片：输入新的 URL。

### 切换预览页面

修改预览区域上方的 URL，然后按 `Enter`。查询参数过长时，可以点击参数按钮单独修改；点击刷新按钮可以重新加载当前页面。

## 常用操作

| 操作                         | 作用                              |
| ---------------------------- | --------------------------------- |
| `Ctrl+C`                     | 开启或关闭元素选择                |
| 长按 `Option` / `Alt`        | 临时选择元素                      |
| `Ctrl+S`                     | 在 VS Code 中打开最接近的源文件   |
| `Enter`                      | 发送 Codex 输入或保存 CSS 属性值  |
| `Shift+Enter`                | 在 Codex 输入框中换行             |
| `$`                          | 打开 Codex skill 选择器           |
| `375px` / `750px` / `Full`   | 修改预览宽度                      |

## 插件配置

```js
import { WebNoCodePreviewWidth, webNoCodeInspector } from "@web-no-code/vite-inspector-plugin";

webNoCodeInspector({
  enabled: true,
  vueInspector: true,
  open: true,
  width: WebNoCodePreviewWidth.Width375,
  serverPort: 4317,
  workspaceRoot: process.cwd()
});
```

| 参数            | 默认值                           | 说明                          |
| --------------- | -------------------------------- | ----------------------------- |
| `enabled`       | `true`                           | 开启或关闭插件                |
| `vueInspector`  | `true`                           | 定位 Vue 组件源码             |
| `open`          | `true`                           | 自动打开编辑器                |
| `width`         | `WebNoCodePreviewWidth.Width375` | 初始预览宽度                  |
| `serverPort`    | `4317`                           | 本地编辑器首选端口            |
| `workspaceRoot` | `process.cwd()`                  | 允许修改的业务项目目录        |

## 使用前须知

- Web No Code 只用于本地开发环境。
- 它会直接修改真实项目文件，请使用 Git 管理项目。
- 动态生成的样式、跨域样式表或缺少 source map 时，可能无法准确定位源码。
- Codex 和 VS Code 功能需要本机安装对应工具。

## 开发本仓库

```bash
pnpm install
pnpm dev
```

在另一个终端启动 Vue 示例：

```bash
pnpm dev:vue
```

示例页面默认运行在 `http://127.0.0.1:5174`，Web No Code 默认运行在 `http://127.0.0.1:4317`。

```bash
pnpm typecheck
pnpm build
```
