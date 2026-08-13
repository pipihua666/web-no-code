export function selectorBreadcrumbs(selector: string) {
  const parts = selector.split(" > ").filter(Boolean);
  return parts.map((part, index) => ({
    selector: parts.slice(0, index + 1).join(" > "),
    label: compactSelectorPart(part)
  }));
}

export function displaySelector(selector: string) {
  return selector.split(" > ").filter(Boolean).map(compactSelectorPart).join(" > ");
}

export function lastDisplayedSelectors(selector: string, limit = 3) {
  return displaySelector(selector).split(" > ").filter(Boolean).slice(-limit).join(" > ");
}

export function leafSelector(selector: string) {
  const leaf = selector.split(" > ").filter(Boolean).at(-1) || "";
  return compactSelectorPart(leaf);
}

export function compactSelectorPart(part: string) {
  return part.replace(/:nth-of-type\(\d+\)/g, "");
}
