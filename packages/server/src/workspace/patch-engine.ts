import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join } from "node:path";
import { parse as parseVueSfc } from "@vue/compiler-sfc";
import { createTwoFilesPatch } from "diff";
import { nanoid } from "nanoid";
import postcss, { type AtRule, type Container, type Declaration, type Document, type Rule } from "postcss";
import scss from "postcss-scss";
import { safeResolve } from "../codex/utils";

export type StylePatch = {
  root: string;
  file: string;
  selector: string;
  selectors?: string[];
  property: string;
  value: string;
  line?: number;
  column?: number;
};

export type TextPatch = {
  root: string;
  file: string;
  search: string;
  searches?: string[];
  line?: number;
  attribute?: string;
  replace: string;
};

export async function previewStylePatch(patch: StylePatch) {
  const filePath = resolvePatchFile(patch.root, patch.file);
  const before = await readFile(filePath, "utf8");
  const after = applyStylePatchToContent(before, selectorCandidates(patch), patch.property, patch.value, patch.line, patch.file);
  return {
    file: patch.file,
    before,
    after,
    diff: createTwoFilesPatch(patch.file, patch.file, before, after, "before", "after")
  };
}

export async function commitStylePatch(patch: StylePatch) {
  const preview = await previewStylePatch(patch);
  const filePath = resolvePatchFile(patch.root, patch.file);
  await writeFile(filePath, preview.after, "utf8");
  return preview;
}

export async function previewTextPatch(patch: TextPatch) {
  const filePath = resolvePatchFile(patch.root, patch.file);
  const before = await readFile(filePath, "utf8");
  const search = textSearchCandidates(patch).find((candidate) => before.includes(candidate));
  const after = search
    ? before.replace(search, patch.replace)
    : replaceAttributeNearLine(before, patch.attribute, patch.replace, patch.line);
  if (!after || after === before) {
    throw new Error(`Search text was not found in ${patch.file}`);
  }
  return {
    file: patch.file,
    before,
    after,
    diff: createTwoFilesPatch(patch.file, patch.file, before, after, "before", "after")
  };
}

function textSearchCandidates(patch: TextPatch) {
  return Array.from(new Set([patch.search, ...(patch.searches || [])].filter(Boolean)));
}

function replaceAttributeNearLine(content: string, attribute = "", value: string, line?: number) {
  if (!attribute || !line) return "";
  const lines = content.split("\n");
  const start = Math.max(0, line - 4);
  const end = Math.min(lines.length - 1, line + 3);
  for (let index = start; index <= end; index += 1) {
    const nextLine = replaceAttributeInLine(lines[index], attribute, value);
    if (nextLine !== lines[index]) {
      lines[index] = nextLine;
      return lines.join("\n");
    }
  }
  return "";
}

function replaceAttributeInLine(line: string | undefined, attribute: string, value: string) {
  if (!line) return line || "";
  const escapedAttribute = escapeRegExp(attribute);
  const quotedPattern = new RegExp(`(\\s)(?::${escapedAttribute}|v-bind:${escapedAttribute}|${escapedAttribute})\\s*=\\s*(["'])(.*?)\\2`);
  if (quotedPattern.test(line)) {
    return line.replace(quotedPattern, (_match, prefix: string, quote: string) => `${prefix}${attribute}=${quote}${value}${quote}`);
  }
  const expressionPattern = new RegExp(`(\\s)${escapedAttribute}\\s*=\\s*\\{[^}]*\\}`);
  if (expressionPattern.test(line)) {
    return line.replace(expressionPattern, `$1${attribute}="${value}"`);
  }
  return line;
}

export async function commitTextPatch(patch: TextPatch) {
  const preview = await previewTextPatch(patch);
  const filePath = resolvePatchFile(patch.root, patch.file);
  await writeFile(filePath, preview.after, "utf8");
  return preview;
}

export async function saveAsset(root: string, originalName: string, buffer: Buffer) {
  const extension = extname(originalName) || ".png";
  const filename = `nocode-${nanoid(8)}${extension}`;
  const assetRelativePath = join("src", "assets", filename);
  const assetPath = safeResolve(root, assetRelativePath);
  await mkdir(dirname(assetPath), { recursive: true });
  await writeFile(assetPath, buffer);
  return {
    filename,
    relativePath: assetRelativePath
  };
}

export async function replaceAsset(root: string, target: string, buffer: Buffer, targets: string[] = []) {
  const assetPath = resolveAssetTarget(root, target, targets);
  await writeFile(assetPath, buffer);
  return {
    relativePath: relativeAssetPath(root, assetPath) || target,
    path: assetPath
  };
}

function resolveAssetTarget(root: string, target: string, targets: string[] = []) {
  const candidates = normalizedAssetCandidates([target, ...targets]);
  for (const candidate of candidates) {
    const resolved = tryResolveAssetCandidate(root, candidate);
    if (!resolved) continue;
    if (existsSync(resolved)) return resolved;
  }
  const fallback = candidates.map((candidate) => tryResolveAssetCandidate(root, candidate)).find(Boolean);
  if (fallback) return fallback;
  return resolveAssetCandidate(root, target);
}

function tryResolveAssetCandidate(root: string, target: string) {
  try {
    return resolveAssetCandidate(root, target);
  } catch {
    return "";
  }
}

function normalizedAssetCandidates(targets: string[]) {
  const candidates: string[] = [];
  for (const target of targets) {
    const normalized = target.trim();
    if (!normalized) continue;
    candidates.push(normalized);
    candidates.push(decodeURIComponent(normalized));
    candidates.push(normalized.replace(/^\/+/, ""));
    candidates.push(decodeURIComponent(normalized).replace(/^\/+/, ""));
  }
  return Array.from(new Set(candidates));
}

function resolveAssetCandidate(root: string, target: string) {
  if (isAbsolute(target)) return safeResolve(root, target);
  const normalized = target.replace(/^\/+/, "");
  const candidates = [
    normalized.replace(/^src\/assets\//, "src/assets/"),
    normalized.replace(/^assets\//, "src/assets/"),
    normalized.replace(/^~?@\//, ""),
    normalized.replace(/^~?@\//, "src/"),
    normalized,
    normalized.replace(/^assets\//, "src/assets/")
  ];
  for (const candidate of Array.from(new Set(candidates))) {
    const resolved = safeResolve(root, candidate);
    if (existsSync(resolved)) return resolved;
  }
  return safeResolve(root, candidates[0]);
}

function relativeAssetPath(root: string, assetPath: string) {
  const normalizedRoot = root.replace(/\/+$/, "");
  return assetPath.startsWith(`${normalizedRoot}/`) ? assetPath.slice(normalizedRoot.length + 1) : "";
}

function applyStylePatchToContent(content: string, selectors: string[], property: string, value: string, line?: number, file?: string) {
  const nextContentByAst = applyStylePatchWithAst(content, selectors, property, value, line, file);
  if (nextContentByAst) return nextContentByAst;

  const nextContentByNestedSelector = applyStylePatchToNestedRule(content, selectors, property, value);
  if (nextContentByNestedSelector) return nextContentByNestedSelector;

  const nextContentByLine = applyStylePatchAtLine(content, property, value, line);
  if (nextContentByLine) return nextContentByLine;

  const selector = findExistingSelector(content, selectors) || selectors[0];
  const escapedSelector = escapeRegExp(selector);
  const rulePattern = new RegExp(`(${escapedSelector}\\s*\\{)([\\s\\S]*?)(\\})`, "m");
  const declaration = `  ${property}: ${value};`;
  const match = content.match(rulePattern);

  if (!match) {
    if (file?.endsWith(".vue")) {
      return appendVueStyleRule(content, selector, declaration);
    }
    return `${content.trimEnd()}\n\n${selector} {\n${declaration}\n}\n`;
  }

  const body = match[2];
  const nextBody = patchRuleBody(body, property, value, declaration);

  return content.replace(rulePattern, `$1${nextBody}$3`);
}

function applyStylePatchWithAst(content: string, selectors: string[], property: string, value: string, line?: number, file?: string) {
  const blocks = styleBlocksForContent(content, file);
  for (const block of blocks) {
    const nextBlockContent = patchStyleBlockWithAst(block.content, selectors, property, value, line, block.lineOffset);
    if (!nextBlockContent || nextBlockContent === block.content) continue;
    return content.slice(0, block.start) + nextBlockContent + content.slice(block.end);
  }
  return "";
}

type StyleBlock = {
  content: string;
  start: number;
  end: number;
  lineOffset: number;
};

function styleBlocksForContent(content: string, file = ""): StyleBlock[] {
  if (!file.endsWith(".vue")) {
    return [{ content, start: 0, end: content.length, lineOffset: 0 }];
  }

  const parsed = parseVueSfc(content, { filename: file });
  return parsed.descriptor.styles
    .map((style) => {
      const loc = style.loc;
      return {
        content: loc.source,
        start: loc.start.offset,
        end: loc.end.offset,
        lineOffset: loc.start.line - 1
      };
    })
    .filter((block) => block.start >= 0 && block.end >= block.start);
}

function patchStyleBlockWithAst(
  content: string,
  selectors: string[],
  property: string,
  value: string,
  line: number | undefined,
  lineOffset: number
) {
  let root: postcss.Root;
  try {
    root = scss.parse(content);
  } catch {
    return "";
  }

  const candidates = declarationCandidates(root, selectors, property, line, lineOffset);
  const declaration = candidates.at(-1);
  if (declaration) {
    declaration.value = value;
    return root.toString(scss);
  }

  const rule = ruleCandidates(root, selectors, line, lineOffset).at(-1);
  if (!rule) return "";
  rule.append({ prop: property, value });
  return root.toString(scss);
}

function declarationCandidates(root: postcss.Root, selectors: string[], property: string, line?: number, lineOffset = 0) {
  const candidates: Declaration[] = [];
  root.walkDecls((declaration) => {
    if (declaration.prop !== property) return;
    if (line && isNearSourceLine(declaration, line, lineOffset)) {
      candidates.push(declaration);
      return;
    }
    const rule = nearestRule(declaration.parent);
    if (rule && selectorMatchesAny(rule, selectors)) candidates.push(declaration);
  });
  return candidates.sort((left, right) => nodeStartOffset(left) - nodeStartOffset(right));
}

function ruleCandidates(root: postcss.Root, selectors: string[], line?: number, lineOffset = 0) {
  const candidates: Rule[] = [];
  root.walkRules((rule) => {
    if (line && isNearSourceLine(rule, line, lineOffset)) {
      candidates.push(rule);
      return;
    }
    if (selectorMatchesAny(rule, selectors)) candidates.push(rule);
  });
  return candidates.sort((left, right) => nodeStartOffset(left) - nodeStartOffset(right));
}

function nearestRule(container: Container | Document | undefined): Rule | null {
  let current: Container | Document | undefined = container;
  while (current) {
    if (current.type === "rule") return current as Rule;
    current = current.parent;
  }
  return null;
}

function selectorMatchesAny(rule: Rule, selectors: string[]) {
  const normalizedRuleSelectors = rule.selectors.map(normalizeSelectorForMatch);
  return selectors.some((selector) => {
    const normalized = normalizeSelectorForMatch(selector);
    return normalizedRuleSelectors.includes(normalized);
  });
}

function normalizeSelectorForMatch(selector: string) {
  return selector
    .replace(/\[data-v-[^\]]+\]/g, "")
    .replace(/:nth-of-type\(\d+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNearSourceLine(node: Declaration | Rule | AtRule, line: number, lineOffset: number) {
  const sourceLine = node.source?.start?.line ? node.source.start.line + lineOffset : 0;
  return sourceLine > 0 && Math.abs(sourceLine - line) <= 3;
}

function nodeStartOffset(node: Declaration | Rule | AtRule) {
  return node.source?.start?.offset || 0;
}

function applyStylePatchToNestedRule(content: string, selectors: string[], property: string, value: string) {
  for (const selector of selectors) {
    const nextContent = patchNestedSelectorPath(content, nestedSelectorPaths(selector), property, value);
    if (nextContent) return nextContent;
  }

  return "";
}

function patchNestedSelectorPath(content: string, selectorPaths: string[][], property: string, value: string) {
  for (const path of selectorPaths) {
    const nextContent = patchNestedPath(content, path, property, value);
    if (nextContent) return nextContent;
  }
  return "";
}

function patchNestedPath(content: string, selectorPath: string[], property: string, value: string): string {
  if (!selectorPath.length) return "";
  const [selector, ...rest] = selectorPath;
  const block = findRuleBlock(content, selector);
  if (!block) return "";

  if (!rest.length) {
    const declaration = `  ${property}: ${value};`;
    const nextBody = patchRuleBody(block.body, property, value, declaration);
    return content.slice(0, block.bodyStart) + nextBody + content.slice(block.bodyEnd);
  }

  const nextBody = patchNestedPath(block.body, rest, property, value);
  if (!nextBody) return "";
  return content.slice(0, block.bodyStart) + nextBody + content.slice(block.bodyEnd);
}

function nestedSelectorPaths(selector: string) {
  const parts = selector.trim().split(/\s+/).filter(Boolean);
  const paths: string[][] = [];
  for (let childStart = parts.length - 1; childStart >= 1; childStart -= 1) {
    const parents = parts.slice(0, childStart);
    const childParts = parts.slice(childStart);
    const child = childParts.join(" ");
    const leaf = childParts.at(-1) || child;
    paths.push(...nestedParentSelectorPaths(parents, child, leaf));
  }
  return uniqueSelectorPaths(paths.filter((path) => path.every(Boolean)));
}

function nestedParentSelectorPaths(parents: string[], child: string, leaf: string) {
  const paths: string[][] = [];
  const parentVariants = nestedParentVariants(parents);
  for (const parentPath of parentVariants) {
    paths.push([...parentPath, `::v-deep ${child}`]);
    paths.push([...parentPath, "::v-deep", child]);
    paths.push([...parentPath, `::v-deep ${leaf}`]);
    paths.push([...parentPath, "::v-deep", leaf]);
    paths.push([...parentPath, `::v-deep & > ${leaf}`]);
    paths.push([...parentPath, "::v-deep", `& > ${leaf}`]);
    paths.push([...parentPath, child]);
    paths.push([...parentPath, leaf]);
  }
  return paths;
}

function nestedParentVariants(parents: string[]) {
  const variants: string[][] = [];
  if (!parents.length) return variants;
  variants.push(parents);

  for (let splitIndex = 1; splitIndex < parents.length; splitIndex += 1) {
    variants.push([parents.slice(0, splitIndex).join(" "), ...parents.slice(splitIndex)]);
  }

  variants.push([parents.join(" ")]);
  return variants;
}

function uniqueSelectorPaths(paths: string[][]) {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = path.join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findRuleBlock(content: string, selector: string) {
  const selectorPattern = new RegExp(`(^|\\})\\s*${escapeRegExp(selector)}\\s*\\{`, "m");
  const match = selectorPattern.exec(content);
  if (!match) return null;
  const openBrace = content.indexOf("{", match.index);
  if (openBrace < 0) return null;
  const closeBrace = findMatchingBrace(content, openBrace);
  if (closeBrace < 0) return null;
  return {
    body: content.slice(openBrace + 1, closeBrace),
    bodyStart: openBrace + 1,
    bodyEnd: closeBrace
  };
}

function findMatchingBrace(content: string, openBrace: number) {
  let depth = 0;
  for (let index = openBrace; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function patchRuleBody(body: string, property: string, value: string, declaration: string) {
  const nextBodyWithUrl = replaceExistingUrlDeclaration(body, property, value);
  if (nextBodyWithUrl) return nextBodyWithUrl;

  const propertyPattern = new RegExp(`(^\\s*${escapeRegExp(property)}\\s*:\\s*)([^;]+)(;?)`, "m");
  return propertyPattern.test(body)
    ? body.replace(propertyPattern, `$1${value}$3`)
    : `${body.trimEnd()}\n${declaration}\n`;
}

function appendVueStyleRule(content: string, selector: string, declaration: string) {
  const rule = `\n${selector} {\n${declaration}\n}\n`;
  const styleCloseIndex = content.lastIndexOf("</style>");
  if (styleCloseIndex >= 0) {
    return `${content.slice(0, styleCloseIndex).trimEnd()}\n${rule}${content.slice(styleCloseIndex)}`;
  }
  return `${content.trimEnd()}\n\n<style scoped>\n${selector} {\n${declaration}\n}\n</style>\n`;
}

function applyStylePatchAtLine(content: string, property: string, value: string, line?: number) {
  if (!line) return "";
  const lines = content.split("\n");
  const start = Math.max(0, line - 4);
  const end = Math.min(lines.length - 1, line + 3);

  for (let index = line - 1; index >= start; index -= 1) {
    const nextLine = replaceStyleLine(lines[index], property, value);
    if (nextLine !== lines[index]) {
      lines[index] = nextLine;
      return lines.join("\n");
    }
  }

  for (let index = line; index <= end; index += 1) {
    const nextLine = replaceStyleLine(lines[index], property, value);
    if (nextLine !== lines[index]) {
      lines[index] = nextLine;
      return lines.join("\n");
    }
  }

  return "";
}

function replaceStyleLine(line: string | undefined, property: string, value: string) {
  if (!line) return line || "";

  if (property === "background-image") {
    const nextUrl = extractCssUrl(value);
    if (nextUrl && /\bbackground(?:-image)?\s*:/.test(line) && /url\((['"]?).*?\1\)/.test(line)) {
      return line.replace(/url\((['"]?)(.*?)\1\)/, (_match, quote: string) => `url(${quote || "\""}${nextUrl}${quote || "\""})`);
    }
  }

  const propertyPattern = new RegExp(`(^\\s*${escapeRegExp(property)}\\s*:\\s*)([^;]+)(;?)`);
  return propertyPattern.test(line) ? line.replace(propertyPattern, `$1${value}$3`) : line;
}

function replaceExistingUrlDeclaration(body: string, property: string, value: string) {
  if (property !== "background-image") return "";
  const nextUrl = extractCssUrl(value);
  if (!nextUrl) return "";

  const backgroundPattern = /(^\s*background(?:-image)?\s*:\s*)([^;]*url\((['"]?)(.*?)\3\)[^;]*)(;?)/m;
  if (!backgroundPattern.test(body)) return "";

  return body.replace(backgroundPattern, (_match, prefix: string, declarationValue: string, quote: string, currentUrl: string, suffix: string) => {
    const quotedUrl = `url(${quote || "\""}${nextUrl}${quote || "\""})`;
    return `${prefix}${declarationValue.replace(`url(${quote}${currentUrl}${quote})`, quotedUrl)}${suffix}`;
  });
}

function extractCssUrl(value: string) {
  const match = value.match(/url\((['"]?)(.*?)\1\)/);
  return match?.[2] || "";
}

function selectorCandidates(patch: StylePatch) {
  return Array.from(new Set([...(patch.selectors || []), patch.selector].filter(Boolean)));
}

function findExistingSelector(content: string, selectors: string[]) {
  return selectors.find((selector) => {
    const rulePattern = new RegExp(`(^|\\})\\s*${escapeRegExp(selector)}\\s*\\{`, "m");
    return rulePattern.test(content);
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolvePatchFile(root: string, file: string) {
  return isAbsolute(file) ? file : safeResolve(root, file);
}
