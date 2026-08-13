import assert from "node:assert/strict";
import test from "node:test";
import {
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
