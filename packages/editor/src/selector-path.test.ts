import assert from "node:assert/strict";
import test from "node:test";
import { displaySelector, lastDisplayedSelectors, leafSelector, selectorBreadcrumbs } from "./selector-path";

test("keeps the complete selector chain when the selected element has an id", () => {
  const path = "body > #app > main.page > section.content:nth-of-type(2) > #current";

  assert.deepEqual(selectorBreadcrumbs(path), [
    { selector: "body", label: "body" },
    { selector: "body > #app", label: "#app" },
    { selector: "body > #app > main.page", label: "main.page" },
    {
      selector: "body > #app > main.page > section.content:nth-of-type(2)",
      label: "section.content"
    },
    {
      selector: "body > #app > main.page > section.content:nth-of-type(2) > #current",
      label: "#current"
    }
  ]);
  assert.equal(displaySelector(path), "body > #app > main.page > section.content > #current");
});

test("uses only the selected element selector for compact labels", () => {
  const path = "body > div.container > div.relationship-rank-list > div.relationship-rank-countdown:nth-of-type(2)";

  assert.equal(leafSelector(path), "div.relationship-rank-countdown");
});

test("takes the last three selectors from the element card display", () => {
  const path = "body > #app > main.page > section.content:nth-of-type(2) > #current";

  assert.equal(lastDisplayedSelectors(path), "main.page > section.content > #current");
  assert.equal(lastDisplayedSelectors("section.content > #current"), "section.content > #current");
});
