import assert from "node:assert/strict";
import test from "node:test";
import { displaySelector, selectorBreadcrumbs } from "./selector-path";

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
