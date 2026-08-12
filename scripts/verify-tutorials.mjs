import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tutorialsRoot = join(repositoryRoot, "tutorials");
const lessons = [
  "01-first-memory",
  "02-mdx-filesystem",
  "03-search-and-scope",
  "04-retrieval-plans",
  "05-expansion-and-reranking",
  "06-persistence-and-maintenance",
  "07-tdb",
  "08-provider-selection",
];
const references = [
  "README.md",
  "public-api.md",
  "configuration.md",
  "data-and-mdx.md",
  "providers-and-injection.md",
  "retrieval-plan.md",
  "persistence-and-recovery.md",
  "tdb.md",
  "troubleshooting.md",
].map((name) => join("reference", name));
const algorithms = [
  "README.md",
  "hybrid-search.md",
  "tag-basis-projection.md",
  "tag-residual-decomposition.md",
  "activation-propagation.md",
  "graph-diffusion.md",
  "propagation-history.md",
  "propagation-support.md",
  "propagation-structure.md",
  "expansion.md",
  "embedding-reranking.md",
  "external-reranking.md",
  "postprocessing.md",
].map((name) => join("algorithms", name));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relativePath) {
  const absolutePath = join(tutorialsRoot, relativePath);
  assert(existsSync(absolutePath), `Missing tutorial file: ${relativePath}`);
  return readFileSync(absolutePath, "utf8");
}

function collectFiles(directory, extension) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(absolutePath, extension));
    else if (entry.isFile() && (!extension || entry.name.endsWith(extension)))
      files.push(absolutePath);
  }
  return files;
}

function gitFiles(prefix) {
  return execFileSync("git", ["ls-files", "--", prefix], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter(Boolean);
}

function verifyLesson(relativeLesson) {
  const source = read(join(relativeLesson, "main.ts"))
    .replace(/\r\n/gu, "\n")
    .replace(/\n$/u, "");
  const document = read(join(relativeLesson, "README.md"));
  for (const required of [
    "学习目标",
    "前置条件",
    "完整代码",
    "运行命令",
    "预期输出",
    "常见错误",
    "下一章",
  ]) {
    assert(
      document.includes(required),
      `${relativeLesson}/README.md is missing section: ${required}`,
    );
  }
  assert(
    /fake/iu.test(document) && /provider/iu.test(document),
    `${relativeLesson}/README.md must explain fake/provider selection`,
  );
  const match =
    /<!-- tutorial-code:start -->\s*```ts\r?\n([\s\S]*?)\r?\n```\s*<!-- tutorial-code:end -->/u.exec(
      document,
    );
  assert(
    match,
    `${relativeLesson}/README.md is missing the synchronized tutorial code block`,
  );
  assert(
    match[1].replace(/\r\n/gu, "\n") === source,
    `${relativeLesson}/README.md code block differs from main.ts`,
  );
}

function main() {
  assert(existsSync(tutorialsRoot), "tutorials/ is missing");
  for (const lesson of lessons) verifyLesson(lesson);
  for (const document of [...references, ...algorithms]) read(document);

  const sourceFiles = collectFiles(tutorialsRoot, ".ts");
  for (const filePath of sourceFiles) {
    const source = readFileSync(filePath, "utf8");
    const displayPath = relative(repositoryRoot, filePath);
    assert(
      !/from ["'][^"']*\/src\//u.test(source),
      `${displayPath} imports an internal source path`,
    );
    assert(
      !/SearchPipeline|PipelineContext|from ["'][^"']*stages\//u.test(source),
      `${displayPath} imports an internal pipeline type`,
    );
  }

  const mdxFiles = collectFiles(join(tutorialsRoot, "data", "content"), ".mdx");
  const contentFiles = collectFiles(join(tutorialsRoot, "data", "content"));
  assert(
    contentFiles.every((filePath) => filePath.endsWith(".mdx")),
    "Tutorial source data must contain only MDX files",
  );
  assert(
    mdxFiles.length === 50,
    `Expected 50 retained tutorial MDX files, found ${mdxFiles.length}`,
  );
  assert(gitFiles("data").length === 0, "Root data/ must not be tracked");
  assert(
    gitFiles(["ex", "amples"].join("")).length === 0,
    "The legacy tutorial tree must not be tracked",
  );
  assert(
    gitFiles("tutorials/*/data/runtime").length === 0,
    "Tutorial runtime data must not be tracked",
  );

  console.log(
    `Tutorial verification passed (${lessons.length} lessons, ${mdxFiles.length} MDX files).`,
  );
}

main();
