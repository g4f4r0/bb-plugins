/** Strip a trailing slash, except on a bare root. */
export function normalizeRoot(root: string): string {
  if (root === "/") return root;
  return root.replace(/\/+$/u, "");
}

/**
 * Join a workspace-relative path onto the environment root.
 * Rejects absolute paths and `..` segments so a client cannot walk out.
 */
export function joinRoot(root: string, relative: string): string {
  const base = normalizeRoot(root);
  if (relative === "" || relative === ".") return base;
  if (relative.startsWith("/") || relative.startsWith("~")) {
    throw new Error("Path is outside the workspace root.");
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Path is outside the workspace root.");
  }
  return `${base}/${relative}`;
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const base = normalizeRoot(root);
  return candidate === base || candidate.startsWith(`${base}/`);
}

/** Workspace-relative path, the identity FileLink needs. */
export function toRelative(root: string, absolute: string): string {
  const base = normalizeRoot(root);
  if (absolute === base) return "";
  if (absolute.startsWith(`${base}/`)) return absolute.slice(base.length + 1);
  throw new Error("Path is outside the workspace root.");
}

export type Kind = "directory" | "file";

const entryCollator = new Intl.Collator(undefined, { sensitivity: "base" });

export function compareEntries(
  a: { kind: Kind; name: string },
  b: { kind: Kind; name: string },
): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return entryCollator.compare(a.name, b.name);
}

/** Open the workspace checkout when it is the only root entry. */
export function defaultFolderToOpen(
  entries: readonly { kind: Kind; relativePath: string }[],
): string | null {
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined || entry.kind !== "directory") {
    return null;
  }
  return entry.relativePath;
}

export function folderIconName(open: boolean): "FolderOpen" | "Folder" {
  return open ? "FolderOpen" : "Folder";
}

const BY_NAME: Record<string, string> = {
  ".babelrc": "javascript",
  ".bash_profile": "bash",
  ".bashrc": "bash",
  ".dockerignore": "docker",
  ".eslintignore": "eslint",
  ".eslintrc": "eslint",
  ".eslintrc.cjs": "eslint",
  ".eslintrc.js": "eslint",
  ".eslintrc.json": "eslint",
  ".eslintrc.yaml": "eslint",
  ".eslintrc.yml": "eslint",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".gitkeep": "git",
  ".gitmodules": "git",
  ".prettierignore": "prettier",
  ".prettierrc": "prettier",
  ".prettierrc.cjs": "prettier",
  ".prettierrc.js": "prettier",
  ".prettierrc.json": "prettier",
  ".prettierrc.mjs": "prettier",
  ".prettierrc.toml": "prettier",
  ".prettierrc.yaml": "prettier",
  ".prettierrc.yml": "prettier",
  ".zprofile": "bash",
  ".zshenv": "bash",
  ".zshrc": "bash",
  "biome.json": "json",
  "bun.lock": "json",
  "claude.md": "markdown",
  "compose.yaml": "docker",
  "compose.yml": "docker",
  "docker-compose.override.yml": "docker",
  "docker-compose.yaml": "docker",
  "docker-compose.yml": "docker",
  dockerfile: "docker",
  "eslint.config.cjs": "eslint",
  "eslint.config.js": "eslint",
  "eslint.config.mjs": "eslint",
  "eslint.config.ts": "eslint",
  gemfile: "ruby",
  "package.json": "json",
  "package-lock.json": "json",
  "pnpm-lock.yaml": "yml",
  "prettier.config.cjs": "prettier",
  "prettier.config.js": "prettier",
  "prettier.config.mjs": "prettier",
  "readme.md": "markdown",
  "tsconfig.json": "json",
};

const BY_EXT: Record<string, string> = {
  astro: "javascript",
  bash: "bash",
  cjs: "javascript",
  css: "css",
  csv: "text",
  cts: "typescript",
  env: "text",
  gif: "image",
  go: "go",
  htm: "html",
  html: "html",
  ico: "image",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  less: "css",
  markdown: "markdown",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  png: "image",
  py: "python",
  pyi: "python",
  rb: "ruby",
  rs: "rust",
  scss: "css",
  sh: "bash",
  sql: "text",
  svg: "image",
  toml: "text",
  ts: "typescript",
  tsx: "typescript",
  txt: "text",
  webp: "image",
  yaml: "yml",
  yml: "yml",
  zsh: "bash",
};

export function fileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function fileExt(path: string): string {
  const name = fileName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1);
}

const IMAGE_EXT = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(fileExt(path));
}

/** Pretty Markdown editor. `.mdx` stays in the code editor. */
export function isMarkdownPath(path: string): boolean {
  const ext = fileExt(path);
  return ext === "md" || ext === "markdown";
}

const HIGHLIGHT_EXT = new Set([
  "astro",
  "bash",
  "bib",
  "c",
  "cc",
  "cfg",
  "cjs",
  "clj",
  "cljs",
  "cmake",
  "conf",
  "cpp",
  "cs",
  "css",
  "cts",
  "cxx",
  "dart",
  "diff",
  "edn",
  "erl",
  "go",
  "h",
  "hpp",
  "hrl",
  "hs",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lua",
  "m",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "mk",
  "ml",
  "mli",
  "mm",
  "mts",
  "php",
  "pl",
  "pm",
  "properties",
  "proto",
  "py",
  "pyi",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "svg",
  "swift",
  "tex",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

export function languageIdForPath(path: string): string | null {
  const name = fileName(path).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile") return "makefile";
  if (name === "cmakelists.txt") return "cmake";
  const ext = fileExt(path);
  return HIGHLIGHT_EXT.has(ext) ? ext : null;
}

/** Absolute host paths only; no `.` / `..` segments. */
export function assertAbsoluteHostPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Path is outside the workspace root.");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Path is outside the workspace root.");
  }
  if (path !== "/" && path.endsWith("/")) {
    throw new Error("Path is outside the workspace root.");
  }
  return path;
}

/** Extensions Sidetree claims as the default opener. */
export const OPENER_EXTENSIONS: readonly string[] = [
  "astro",
  "avif",
  "bash",
  "bib",
  "bmp",
  "c",
  "cc",
  "cfg",
  "cjs",
  "clj",
  "cljs",
  "cmake",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "cts",
  "cxx",
  "dart",
  "diff",
  "edn",
  "env",
  "erl",
  "ex",
  "exs",
  "gif",
  "go",
  "graphql",
  "gz",
  "h",
  "hpp",
  "hrl",
  "hs",
  "htm",
  "html",
  "ico",
  "ini",
  "ipynb",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "log",
  "lua",
  "m",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "mk",
  "ml",
  "mli",
  "mm",
  "mts",
  "nix",
  "php",
  "pl",
  "pm",
  "png",
  "prisma",
  "properties",
  "proto",
  "py",
  "pyi",
  "rb",
  "rs",
  "rst",
  "scss",
  "sh",
  "sql",
  "svelte",
  "svg",
  "swift",
  "tex",
  "tf",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "vue",
  "wasm",
  "webp",
  "xml",
  "yaml",
  "yml",
  "zig",
  "zsh",
];

export function fileIconToken(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  const name = slash === -1 ? relativePath : relativePath.slice(slash + 1);
  const lower = name.toLowerCase();
  const named = BY_NAME[lower];
  if (named !== undefined) return named;
  const dot = lower.lastIndexOf(".");
  const ext = dot <= 0 ? lower.replace(/^\./u, "") : lower.slice(dot + 1);
  return BY_EXT[ext] ?? "default";
}
