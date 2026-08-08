import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const scanner = resolve("scripts/verify-no-secrets.mjs");
const temporaryDirectories: string[] = [];

function createRepository(files: Record<string, string>, trackedPaths = Object.keys(files)): string {
  const directory = mkdtempSync(join(tmpdir(), "foodguard-secret-scan-"));
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  if (trackedPaths.length > 0) {
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "--force", "--", ...trackedPaths], { cwd: directory });
  }
  return directory;
}

function scan(directory: string) {
  return spawnSync(process.execPath, [scanner], {
    cwd: directory,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("repository secret scanner", () => {
  it("allows blank example keys and documentation variable names", () => {
    const directory = createRepository({
      ".env.example": "NEXT_PUBLIC_FOODGUARD_ADDRESS=\nVERCEL_TOKEN=\n",
      "README.md": "Provide VERCEL_TOKEN through the deployment environment; never commit its value.\n",
      "public/evidence/example.json": "{\"sha256\":\"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n",
    });

    const result = scan(directory);

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["private key", "app/config.ts", "const PRIVATE_KEY = '0x" + "1".repeat(64) + "';\n"],
    ["seed phrase", "lib/wallet.ts", "export const seedPhrase = '" + ["apple", "bridge", "candle", "dragon", "eagle", "forest", "garden", "harbor", "island", "jungle", "kingdom", "lemon"].join(" ") + "';\n"],
    ["Vercel credential", "scripts/deploy.mjs", "const token = 'vercel_" + "abcdefghijklmnopqrstuvwxyz012345" + "';\n"],
  ])("fails on a staged %s without echoing the matched value", (_case, path, secret) => {
    const directory = createRepository({ [path]: secret });

    const result = scan(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path);
    expect(result.stderr).not.toContain(secret.trim());
  });

  it.each([
    ".env.local",
    ".next/server/app.js",
    "node_modules/package/index.js",
    ".superpowers/task-notes.md",
    "work/research.md",
    "research/browser-notes.md",
    "tasks/task-11-output.md",
  ])("rejects a tracked unsafe repository artifact: %s", (path) => {
    const directory = createRepository({ [path]: "fixture artifact\n" });

    const result = scan(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path);
  });

  it.each([".env.local", "app/.env.local"])(
    "rejects an ordinary ignored local environment file: %s",
    (path) => {
      const secret = "ignored local configuration must not be read or printed\n";
      const directory = createRepository(
        {
          ".gitignore": ".env.local\n",
          [path]: secret,
        },
        [".gitignore"],
      );

      const result = scan(directory);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(path);
      expect(result.stderr).not.toContain(secret.trim());
    },
  );

  it("scans untracked public-source files before they are staged", () => {
    const directory = createRepository(
      { "app/untracked.ts": "export const VERCEL_TOKEN = 'vercel_" + "abcdefghijklmnopqrstuvwxyz012345" + "';\n" },
      [],
    );

    const result = scan(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("app/untracked.ts");
  });
});
