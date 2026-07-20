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

export function compactSelectorPart(part: string) {
  return part.replace(/:nth-of-type\(\d+\)/g, "");
}
