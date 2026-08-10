import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excludedDirectories = new Set([
  ".git",
  "dist",
  "dist-test",
  "eval",
  "fixtures",
  "node_modules",
  "target",
]);
const documentExtensions = new Set([".md", ".mdx"]);
const markdownLinkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
const maintainedDocumentRoots = [
  "README.md",
  "INDEX.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs",
  "data/README.md",
  "data/AGENTS.md",
  "examples",
  "scripts",
  "tests/README.md",
  "tests/AGENTS.md",
  "rust-vexus-lite",
];

function isExcludedPath(filePath) {
  const relativePath = relative(repositoryRoot, filePath);
  return relativePath.split(sep).some((segment) => excludedDirectories.has(segment));
}

function collectDocumentsRecursively(directory) {
  const documents = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (isExcludedPath(entryPath)) continue;

    if (entry.isDirectory()) {
      documents.push(...collectDocumentsRecursively(entryPath));
      continue;
    }

    if (entry.isFile() && documentExtensions.has(extname(entry.name).toLowerCase())) {
      documents.push(entryPath);
    }
  }

  return documents;
}

function collectDocuments() {
  return maintainedDocumentRoots.flatMap((root) => {
    const rootPath = resolve(repositoryRoot, root);
    if (!existsSync(rootPath)) return [];
    return lstatSync(rootPath).isDirectory()
      ? collectDocumentsRecursively(rootPath)
      : [rootPath];
  });
}

function normalizeTarget(rawTarget) {
  const target = rawTarget.replace(/^<|>$/g, "");
  const hashIndex = target.indexOf("#");
  const queryIndex = target.indexOf("?");
  const suffixIndex = [hashIndex, queryIndex]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return suffixIndex === undefined ? target : target.slice(0, suffixIndex);
}

function shouldSkipTarget(target) {
  return (
    target === "" ||
    target.startsWith("#") ||
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("tel:") ||
    target.startsWith("data:") ||
    target.startsWith("javascript:")
  );
}

function resolveDocumentTarget(sourcePath, rawTarget) {
  const target = normalizeTarget(rawTarget);
  if (shouldSkipTarget(target)) return null;

  const targetPath = target.startsWith("/")
    ? resolve(repositoryRoot, `.${target}`)
    : resolve(dirname(sourcePath), target);

  if (isExcludedPath(targetPath)) {
    return { targetPath, reason: "excluded" };
  }

  if (existsSync(targetPath)) {
    const stat = lstatSync(targetPath);
    if (stat.isDirectory()) {
      const indexPath = resolve(targetPath, "index.md");
      const readmePath = resolve(targetPath, "README.md");
      if (existsSync(indexPath)) return { targetPath: indexPath };
      if (existsSync(readmePath)) return { targetPath: readmePath };
    } else {
      return { targetPath };
    }
  }

  return { targetPath, reason: "missing" };
}

function maskFencedCode(source) {
  let fenceCharacter = null;

  return source
    .split(/(\r?\n)/)
    .map((part) => {
      if (part === "\n" || part === "\r\n") return part;

      const fence = part.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceCharacter === null && fence) {
        fenceCharacter = fence[1][0];
        return part.replace(/[^\r]/g, " ");
      }

      if (fenceCharacter !== null) {
        if (fence && fence[1][0] === fenceCharacter) fenceCharacter = null;
        return part.replace(/[^\r]/g, " ");
      }

      return part;
    })
    .join("");
}

function findBrokenLinks(sourcePath) {
  const source = maskFencedCode(readFileSync(sourcePath, "utf8"));
  const errors = [];
  let match;

  while ((match = markdownLinkPattern.exec(source)) !== null) {
    const rawTarget = match[1];
    if (!rawTarget) continue;

    const resolved = resolveDocumentTarget(sourcePath, rawTarget);
    if (!resolved || !resolved.reason) continue;

    const line = source.slice(0, match.index).split(/\r?\n/).length;
    const displayPath = relative(repositoryRoot, resolved.targetPath) || ".";
    errors.push({
      file: relative(repositoryRoot, sourcePath),
      line,
      target: rawTarget,
      reason: resolved.reason,
      resolvedPath: displayPath,
    });
  }

  return errors;
}

function main() {
  const documents = collectDocuments().sort();
  const errors = documents.flatMap(findBrokenLinks);

  if (errors.length > 0) {
    console.error(`Documentation link check failed (${errors.length} issue(s)):`);
    for (const error of errors) {
      const detail =
        error.reason === "excluded"
          ? "target is outside the maintained documentation scope"
          : `resolved path does not exist: ${error.resolvedPath}`;
      console.error(`- ${error.file}:${error.line} -> ${error.target} (${detail})`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Documentation link check passed (${documents.length} Markdown/MDX files).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { collectDocuments, findBrokenLinks, normalizeTarget, resolveDocumentTarget };
