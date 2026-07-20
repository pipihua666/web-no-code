import type { TargetAlias } from "./api";

type AssetStyleSource = {
  file?: string;
  value?: string;
};

export function resolveBackgroundAssetSource(styleSources: Record<string, AssetStyleSource> = {}) {
  const backgroundSources = [
    styleSources["background-image"],
    styleSources.background,
    ...Object.entries(styleSources)
      .filter(([property]) => property.startsWith("background"))
      .map(([, source]) => source)
  ].filter((source): source is AssetStyleSource => Boolean(source));

  return (
    backgroundSources.find((source) => source.file && extractCssUrl(source.value || "")) ||
    backgroundSources.find((source) => source.file) ||
    backgroundSources[0] ||
    null
  );
}

export function resolveAssetPreviewUrl(
  src: string,
  baseUrl?: string,
  aliases: TargetAlias[] = [],
  workspaceRoot = "",
  version = 0,
  sourceFile = ""
) {
  const normalized = normalizeProjectAssetUrl(src, aliases, workspaceRoot, sourceFile);
  const resolved = resolveAssetUrl(normalized, baseUrl);
  return version ? addCacheBustParam(resolved, version) : resolved;
}

function addCacheBustParam(src: string, version: number) {
  try {
    const url = new URL(src, window.location.href);
    url.searchParams.set("__wnc_preview", String(version));
    return url.href;
  } catch {
    const separator = src.includes("?") ? "&" : "?";
    return `${src}${separator}__wnc_preview=${version}`;
  }
}

function normalizeProjectAssetUrl(
  src: string,
  aliases: TargetAlias[] = [],
  workspaceRoot = "",
  sourceFile = ""
) {
  const trimmed = src.trim();
  const relative = normalizeRelativeProjectAssetUrl(trimmed, sourceFile, workspaceRoot);
  if (relative) return relative;
  const aliased = normalizeAliasedProjectAssetUrl(trimmed, aliases, workspaceRoot);
  if (aliased) return aliased;
  if (/^~?@\//.test(trimmed)) {
    const aliasPath = trimmed.replace(/^~?@\//, "");
    return workspaceRoot ? normalizePreviewPathFromRoot(`${workspaceRoot}/${aliasPath}`, workspaceRoot) : `/${aliasPath}`;
  }
  if (/^src\/assets\//.test(trimmed)) return `/${trimmed}`;
  if (/^assets\//.test(trimmed)) return `/${trimmed}`;
  return trimmed;
}

function normalizeRelativeProjectAssetUrl(src: string, sourceFile: string, workspaceRoot: string) {
  if (!/^\.\.?\//.test(src) || !sourceFile) return "";

  const suffixOffset = src.search(/[?#]/);
  const assetPath = suffixOffset >= 0 ? src.slice(0, suffixOffset) : src;
  const suffix = suffixOffset >= 0 ? src.slice(suffixOffset) : "";
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const normalizedSource = sourceFile.replace(/\\/g, "/").replace(/^\/@fs\//, "/").split(/[?#]/)[0];
  const absoluteSource = normalizedSource.startsWith("/") || /^[A-Za-z]:\//.test(normalizedSource)
    ? normalizeAbsolutePath(normalizedSource)
    : normalizedRoot
      ? `${normalizedRoot}/${normalizedSource.replace(/^\/+/, "")}`
      : "";
  if (!absoluteSource) return "";

  const sourceDirectory = absoluteSource.slice(0, absoluteSource.lastIndexOf("/"));
  const resolvedPath = normalizeAbsolutePath(`${sourceDirectory}/${assetPath}`);
  return `/@fs${resolvedPath}${suffix}`;
}

function normalizeAbsolutePath(path: string) {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function normalizeAliasedProjectAssetUrl(src: string, aliases: TargetAlias[], workspaceRoot: string) {
  const match = aliases
    .filter((alias) => alias.find && alias.replacement)
    .sort((left, right) => right.find.length - left.find.length)
    .find((alias) => src === alias.find || src.startsWith(`${alias.find}/`));
  if (!match) return "";
  const suffix = src.slice(match.find.length).replace(/^\/+/, "");
  const replacement = match.replacement.replace(/\/+$/, "");
  const resolvedPath = suffix ? `${replacement}/${suffix}` : replacement;
  return normalizePreviewPathFromRoot(resolvedPath, workspaceRoot);
}

function normalizePreviewPathFromRoot(path: string, workspaceRoot: string) {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return `/@fs${normalizedPath}`;
  }
  return normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
}

function normalizeWorkspaceRoot(workspaceRoot: string) {
  const normalized = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
}

function resolveAssetUrl(src: string, baseUrl?: string) {
  try {
    return new URL(src, baseUrl || window.location.href).href;
  } catch {
    return src;
  }
}

function extractCssUrl(value: string) {
  const match = value.match(/url\((['"]?)(.*?)\1\)/);
  return match?.[2] || "";
}
