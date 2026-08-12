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
  "tutorials",
  "scripts",
  "tests/README.md",
  "tests/AGENTS.md",
  "rust-vexus-lite",
];
const runtimeExportSourcePath = resolve(repositoryRoot, "src/index.ts");
const runtimeExportDocumentationPath = resolve(repositoryRoot, "docs/API.md");
const runtimeExportStartMarker = "<!-- runtime-exports:start -->";
const runtimeExportEndMarker = "<!-- runtime-exports:end -->";
const persistenceSchemaSourcePath = resolve(
  repositoryRoot,
  "src/providers/sqlite/schema.ts",
);
const propagationHistorySourcePath = resolve(
  repositoryRoot,
  "src/stages/tag-retrieval/propagation-history.ts",
);
const persistenceDocumentationPath = resolve(repositoryRoot, "docs/PERSISTENCE.md");
const persistenceContractStartMarker = "<!-- canonical-schema:start -->";
const persistenceContractEndMarker = "<!-- canonical-schema:end -->";

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

function parseRuntimeExportLines(lines, sourceLabel) {
  const names = [];

  for (const line of lines) {
    const normalized = line
      .replace(/\/\/.*$/, "")
      .trim()
      .replace(/,$/, "");
    if (!normalized) continue;

    const match = normalized.match(
      /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
    );
    if (!match) {
      throw new Error(`Invalid runtime export line in ${sourceLabel}: ${line}`);
    }
    names.push(match[2] || match[1]);
  }

  return names;
}

function extractRuntimeExportsFromSource(source) {
  const match = source.match(/\bexport\s*\{([\s\S]*?)\n\};/);
  if (!match) {
    throw new Error(`Runtime export block not found in ${runtimeExportSourcePath}`);
  }
  return parseRuntimeExportLines(match[1].split(/\r?\n/), runtimeExportSourcePath);
}

function extractMarkedRuntimeExports(document) {
  const start = document.indexOf(runtimeExportStartMarker);
  const end = document.indexOf(runtimeExportEndMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `Runtime export documentation markers not found in ${runtimeExportDocumentationPath}`,
    );
  }

  const block = document.slice(start + runtimeExportStartMarker.length, end);
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"));
  return parseRuntimeExportLines(lines, runtimeExportDocumentationPath);
}

function findRuntimeExportDrift() {
  try {
    const documentedSource = readFileSync(runtimeExportDocumentationPath, "utf8");
    const sourceExports = extractRuntimeExportsFromSource(
      readFileSync(runtimeExportSourcePath, "utf8"),
    );
    const documentedExports = extractMarkedRuntimeExports(documentedSource);

    const firstDifference = sourceExports.findIndex(
      (name, index) => documentedExports[index] !== name,
    );
    const sameLength = sourceExports.length === documentedExports.length;
    if (sameLength && firstDifference === -1) return [];

    const differenceIndex =
      firstDifference === -1
        ? Math.min(sourceExports.length, documentedExports.length)
        : firstDifference;
    return [
      {
        file: relative(repositoryRoot, runtimeExportDocumentationPath),
        line: documentedSource
          .slice(0, documentedSource.indexOf(runtimeExportStartMarker))
          .split(/\r?\n/).length,
        target: "runtime export list",
        reason: "runtime-export-drift",
        detail:
          `source and documentation differ at position ${differenceIndex + 1}: ` +
          `source=${sourceExports[differenceIndex] ?? "<end>"}, ` +
          `docs=${documentedExports[differenceIndex] ?? "<end>"}`,
      },
    ];
  } catch (error) {
    return [
      {
        file: relative(repositoryRoot, runtimeExportDocumentationPath),
        line: 1,
        target: "runtime export list",
        reason: "runtime-export-drift",
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

function extractCanonicalPersistenceContract(schemaSource, historySource) {
  const tableBlock = schemaSource.match(
    /export const CANONICAL_TABLE_DEFINITIONS[\s\S]*?\n};\n\nexport const CANONICAL_SCHEMA_VERSION/,
  );
  const version = schemaSource.match(
    /export const CANONICAL_SCHEMA_VERSION\s*=\s*(\d+);/,
  );
  const historySchema = historySource.match(
    /PROPAGATION_HISTORY_SCHEMA\s*=\s*["']([^"']+)["']/,
  );
  if (!tableBlock || !version || !historySchema) {
    throw new Error("canonical persistence source markers not found");
  }

  const tables = [...tableBlock[0].matchAll(/^  ([A-Za-z0-9_]+):\s*`/gm)].map(
    (match) => match[1],
  );
  const historyTables = tables.filter((table) =>
    table.startsWith("propagation_history_"),
  );
  return {
    schemaVersion: Number(version[1]),
    historySchema: historySchema[1],
    historyStorage:
      historyTables.includes("propagation_history_state") &&
      historyTables.includes("propagation_history_edges")
        ? "relational-tables"
        : "unknown",
    tables,
  };
}

function extractMarkedPersistenceContract(document) {
  const start = document.indexOf(persistenceContractStartMarker);
  const end = document.indexOf(persistenceContractEndMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `Persistence contract markers not found in ${persistenceDocumentationPath}`,
    );
  }

  const lines = document
    .slice(start + persistenceContractStartMarker.length, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const schemaVersion = lines.find((line) => line.startsWith("schema-version:"));
  const historySchema = lines.find((line) => line.startsWith("history-schema:"));
  const historyStorage = lines.find((line) => line.startsWith("history-storage:"));
  const tableStart = lines.indexOf("tables:");
  if (!schemaVersion || !historySchema || !historyStorage || tableStart < 0) {
    throw new Error("incomplete persistence contract marker block");
  }
  return {
    schemaVersion: Number(schemaVersion.slice("schema-version:".length).trim()),
    historySchema: historySchema.slice("history-schema:".length).trim(),
    historyStorage: historyStorage.slice("history-storage:".length).trim(),
    tables: lines.slice(tableStart + 1),
  };
}

function findPersistenceContractDrift() {
  try {
    const expected = extractCanonicalPersistenceContract(
      readFileSync(persistenceSchemaSourcePath, "utf8"),
      readFileSync(propagationHistorySourcePath, "utf8"),
    );
    const documented = extractMarkedPersistenceContract(
      readFileSync(persistenceDocumentationPath, "utf8"),
    );
    if (
      expected.schemaVersion === documented.schemaVersion &&
      expected.historySchema === documented.historySchema &&
      expected.historyStorage === documented.historyStorage &&
      JSON.stringify(expected.tables) === JSON.stringify(documented.tables)
    ) {
      return [];
    }
    return [
      {
        file: relative(repositoryRoot, persistenceDocumentationPath),
        line: 1,
        target: "canonical persistence contract",
        reason: "persistence-contract-drift",
        detail: `source=${JSON.stringify(expected)} docs=${JSON.stringify(documented)}`,
      },
    ];
  } catch (error) {
    return [
      {
        file: relative(repositoryRoot, persistenceDocumentationPath),
        line: 1,
        target: "canonical persistence contract",
        reason: "persistence-contract-drift",
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

function main() {
  const documents = collectDocuments().sort((left, right) => left.localeCompare(right));
  const errors = [
    ...documents.flatMap(findBrokenLinks),
    ...findRuntimeExportDrift(),
    ...findPersistenceContractDrift(),
  ];

  if (errors.length > 0) {
    console.error(`Documentation verification failed (${errors.length} issue(s)):`);
    for (const error of errors) {
      const detail =
        error.reason === "runtime-export-drift"
          ? error.detail
          : error.reason === "persistence-contract-drift"
            ? error.detail
            : error.reason === "excluded"
              ? "target is outside the maintained documentation scope"
              : `resolved path does not exist: ${error.resolvedPath}`;
      console.error(`- ${error.file}:${error.line} -> ${error.target} (${detail})`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Documentation verification passed (${documents.length} Markdown/MDX files).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export {
  collectDocuments,
  extractMarkedRuntimeExports,
  extractRuntimeExportsFromSource,
  findBrokenLinks,
  findRuntimeExportDrift,
  extractCanonicalPersistenceContract,
  extractMarkedPersistenceContract,
  findPersistenceContractDrift,
  normalizeTarget,
  resolveDocumentTarget,
};
