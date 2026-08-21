import assert from "node:assert/strict";
import test from "node:test";
import {
  AppServerProvider,
  compactCodexSelectorPath,
  compactSelectedElementContext
} from "./app-server-provider";

test("keeps the last three selectors from the CSS Rules path", () => {
  assert.equal(
    compactCodexSelectorPath(
      "body > div.container > div.relationship-rank-list > div.relationship-rank-countdown:nth-of-type(2)"
    ),
    "div.container > div.relationship-rank-list > div.relationship-rank-countdown"
  );
});

test("keeps CSS Rules paths with fewer than three selectors", () => {
  assert.equal(compactCodexSelectorPath("main.page > section.content:nth-of-type(2)"), "main.page > section.content");
  assert.equal(compactCodexSelectorPath("#current"), "#current");
});

test("keeps the selector already derived from the element card display", () => {
  assert.deepEqual(
    compactSelectedElementContext({
      selector: "main.page > section.content > #current",
      pathSelector: "body > #app > main.page > section.content > #current"
    }),
    {
      selector: "main.page > section.content > #current",
      elementSource: undefined
    }
  );
});

test("returns an unavailable status when Codex detection fails", async () => {
  const previousCodexBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = "/definitely/missing/codex";

  try {
    const provider = new AppServerProvider({ emit() {} });
    assert.deepEqual(await provider.status(), {
      provider: "app-server",
      mode: "app-server",
      available: false,
      reason: "spawn /definitely/missing/codex ENOENT"
    });
  } finally {
    if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousCodexBin;
  }
});
