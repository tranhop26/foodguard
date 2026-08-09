import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const publicSourcePathspecs = [
  ".env.example",
  "README.md",
  "app",
  "components",
  "contracts",
  "deploy",
  "docs",
  "lib",
  "locales",
  "public",
  "scripts",
  "tests",
  "eslint.config.mjs",
  "next.config.ts",
  "playwright.config.ts",
  "package.json",
  "package-lock.json",
  "postcss.config.mjs",
  "pyproject.toml",
  "tsconfig.json",
  "vitest.config.ts",
];

const localEnvironmentSearchRoots = [
  "app",
  "components",
  "contracts",
  "deploy",
  "docs",
  "lib",
  "locales",
  "public",
  "scripts",
  "tests",
];
const excludedTraversalDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const maximumLocalEnvironmentDepth = 8;

const unsafePathRules = [
  {
    id: "LOCAL_ENV_FILE",
    pattern: /(?:^|\/)\.env\.local$/i,
  },
  {
    id: "GENERATED_OR_DEPENDENCY_ARTIFACT",
    pattern: /(?:^|\/)(?:node_modules|\.next(?:-[^/]*)?|dist|build|out|coverage|\.cache|\.turbo|\.pytest_cache|__pycache__)(?:\/|$)/i,
  },
  {
    id: "PRIVATE_WORK_ARTIFACT",
    pattern: /(?:^|\/)(?:\.superpowers|work|research|tasks?)(?:\/|$)/i,
  },
  {
    id: "COMPILER_CACHE",
    pattern: /\.tsbuildinfo$/i,
  },
];

const contentRules = [
  {
    id: "PEM_PRIVATE_KEY",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    id: "HEX_PRIVATE_KEY",
    pattern: /(?:private[_-]?key|secret[_-]?key)["']?\s*(?:=|:)\s*["']?(?:0x)?[0-9a-f]{64}(?=["'\s,;}]|$)/i,
  },
  {
    id: "MNEMONIC_OR_SEED_PHRASE",
    pattern: /(?:mnemonic|seed[_ -]?phrase|recovery[_ -]?phrase)["']?\s*(?:=|:)\s*["']?[a-z]+(?:\s+[a-z]+){11,23}(?=["'\r\n;}]|$)/i,
  },
  {
    id: "VERCEL_TOKEN",
    pattern: /(?:vercel|vcp)_[a-z0-9_-]{20,}/i,
  },
  {
    id: "VERCEL_TOKEN_ASSIGNMENT",
    pattern: /VERCEL_TOKEN\s*=\s*["']?(?!\s*(?:["']|$|<|\$\{|example|replace|your[_-]))[^\s"']{20,}/i,
  },
];

function gitOutput(args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nulPaths(value) {
  return value.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/"));
}

function worktreeBuffer(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function indexBuffer(path) {
  try {
    return gitOutput(["show", `:${path}`], null);
  } catch {
    return null;
  }
}

function isText(buffer) {
  return !buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
}

function contentFindings(path, buffer) {
  if (!buffer || !isText(buffer)) return [];
  const content = buffer.toString("utf8");
  return contentRules
    .filter((rule) => rule.pattern.test(content))
    .map((rule) => `${path} [${rule.id}]`);
}

function localEnvironmentFiles() {
  const repositoryRoot = process.cwd();
  const found = new Set();
  if (existsSync(join(repositoryRoot, ".env.local"))) found.add(".env.local");

  function inspect(directory, depth) {
    if (depth > maximumLocalEnvironmentDepth) return;
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === ".env.local") {
        found.add(relative(repositoryRoot, path).replaceAll("\\", "/"));
      } else if (
        entry.isDirectory() &&
        !excludedTraversalDirectories.has(entry.name.toLowerCase())
      ) {
        inspect(path, depth + 1);
      }
    }
  }

  for (const root of localEnvironmentSearchRoots) {
    const path = join(repositoryRoot, root);
    if (existsSync(path)) inspect(path, 1);
  }
  return [...found].sort();
}

let tracked;
let staged;
let publicUntracked;
let localEnvironments;
try {
  tracked = nulPaths(gitOutput(["ls-files", "--cached", "-z"]));
  staged = nulPaths(gitOutput(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]));
  publicUntracked = nulPaths(gitOutput([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...publicSourcePathspecs,
  ]));
  localEnvironments = localEnvironmentFiles();
} catch {
  console.error("Secret scan failed: could not inspect this FoodGuard Git worktree.");
  process.exit(1);
}

const trackedOrStaged = new Set([...tracked, ...staged]);
const findings = new Set();

for (const path of [...trackedOrStaged].sort()) {
  for (const rule of unsafePathRules) {
    if (rule.pattern.test(path)) findings.add(`${path} [${rule.id}]`);
  }
}

for (const path of localEnvironments) findings.add(`${path} [LOCAL_ENV_FILE]`);

for (const path of [...new Set([...tracked, ...publicUntracked])].sort()) {
  for (const finding of contentFindings(path, worktreeBuffer(path))) findings.add(finding);
}

for (const path of [...staged].sort()) {
  for (const finding of contentFindings(path, indexBuffer(path))) findings.add(finding);
}

if (findings.size > 0) {
  console.error("Secret scan failed. Matches are redacted; only paths and rule IDs follow:");
  for (const finding of [...findings].sort()) console.error(` - ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed (${tracked.length} tracked, ${staged.length} staged, ${publicUntracked.length} untracked public-source files).`);
