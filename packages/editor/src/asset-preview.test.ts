import assert from "node:assert/strict";
import test from "node:test";
import { resolveAssetPreviewUrl, resolveBackgroundAssetSource } from "./asset-preview";

const targetUrl = "http://127.0.0.1:8080/";
const workspaceRoot = "/workspace/activity";

test("resolves a relative background image from an absolute style source file", () => {
  const result = resolveAssetPreviewUrl(
    "../assets/label.png",
    targetUrl,
    [],
    workspaceRoot,
    0,
    "/workspace/activity/components/TodayLuckyKoi.vue"
  );

  assert.equal(result, "http://127.0.0.1:8080/@fs/workspace/activity/assets/label.png");
});

test("resolves a relative background image from a workspace-relative style source file", () => {
  const result = resolveAssetPreviewUrl(
    "../assets/label.png?inline#preview",
    targetUrl,
    [],
    workspaceRoot,
    0,
    "components/TodayLuckyKoi.vue"
  );

  assert.equal(result, "http://127.0.0.1:8080/@fs/workspace/activity/assets/label.png?inline#preview");
});

test("keeps Vite runtime asset URLs unchanged", () => {
  const result = resolveAssetPreviewUrl(
    "/@fs/workspace/activity/assets/label.png",
    targetUrl,
    [],
    workspaceRoot,
    0,
    "/workspace/activity/components/TodayLuckyKoi.vue"
  );

  assert.equal(result, "http://127.0.0.1:8080/@fs/workspace/activity/assets/label.png");
});

test("preserves document-relative fallback when the style source is unknown", () => {
  const result = resolveAssetPreviewUrl("../assets/label.png", targetUrl, [], workspaceRoot);

  assert.equal(result, "http://127.0.0.1:8080/assets/label.png");
});

test("uses a sourced background shorthand instead of a runtime background-image", () => {
  const result = resolveBackgroundAssetSource({
    "background-image": {
      value: 'url("/@fs/workspace/activity/assets/label.png")'
    },
    background: {
      file: "components/TodayLuckyKoi.vue",
      value: "url('../assets/label.png') no-repeat center/100%"
    }
  });

  assert.deepEqual(result, {
    file: "components/TodayLuckyKoi.vue",
    value: "url('../assets/label.png') no-repeat center/100%"
  });
});

test("supports Windows workspace and source paths", () => {
  const result = resolveAssetPreviewUrl(
    "../assets/label.png",
    targetUrl,
    [],
    "C:\\workspace\\activity",
    0,
    "C:\\workspace\\activity\\components\\TodayLuckyKoi.vue"
  );

  assert.equal(result, "http://127.0.0.1:8080/@fs/C:/workspace/activity/assets/label.png");
});

test("keeps relative assets outside the workspace on Vite's file-system route", () => {
  const result = resolveAssetPreviewUrl(
    "../../shared/label.png",
    targetUrl,
    [],
    workspaceRoot,
    0,
    "/workspace/activity/components/TodayLuckyKoi.vue"
  );

  assert.equal(result, "http://127.0.0.1:8080/@fs/workspace/shared/label.png");
});
