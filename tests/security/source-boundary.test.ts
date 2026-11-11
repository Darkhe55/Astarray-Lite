import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../../src", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

const windowsUserPrefix = ["C:", "Users"].join("\\");
const privateUiName = ["astarray", "ui"].join("-");
const localDocsName = [".local", "docs"].join("-");
const taskCardPattern = new RegExp(["LITE", "[0-9]+"].join("-"));
const privateKeyMarker = ["BEGIN", "PRIVATE", "KEY"].join(" ");
const githubTokenMarker = ["ghp", "_"].join("");
const awsKeyMarker = ["AK", "IA"].join("");

const forbiddenMarkers: ReadonlyArray<{ readonly marker: string; readonly reason: string }> = [
  { marker: windowsUserPrefix, reason: "absolute Windows user path" },
  { marker: privateUiName, reason: "private UI repository name" },
  { marker: localDocsName, reason: "local planning directory" },
  { marker: privateKeyMarker, reason: "private key marker" },
  { marker: githubTokenMarker, reason: "GitHub token marker" },
  { marker: awsKeyMarker, reason: "AWS access key marker" },
];

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function checkImport(
  filePath: string,
  specifier: string,
  violations: Violation[],
): void {
  const line = 1;
  if (specifier.startsWith("node:")) return;
  if (!specifier.startsWith(".")) {
    violations.push({ file: filePath, line, reason: `bare import not allowed: ${specifier}` });
    return;
  }

  const resolved = path.resolve(path.dirname(filePath), specifier);
  if (!isInside(sourceRoot, resolved)) {
    violations.push({ file: filePath, line, reason: `import escapes src: ${specifier}` });
    return;
  }

  const candidate = resolved.endsWith(".js")
    ? resolved.slice(0, -".js".length) + ".ts"
    : resolved;
  if (!existsSync(candidate)) {
    violations.push({ file: filePath, line, reason: `import target missing: ${specifier}` });
  }
}

function scanSourceTree(directory: string): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of listTypeScriptFiles(directory)) {
    const text = readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/u);

    for (const { marker, reason } of forbiddenMarkers) {
      lines.forEach((lineText, index) => {
        if (lineText.includes(marker)) {
          violations.push({ file: filePath, line: index + 1, reason });
        }
      });
    }

    lines.forEach((lineText, index) => {
      if (taskCardPattern.test(lineText)) {
        violations.push({ file: filePath, line: index + 1, reason: "task-card identifier" });
      }
    });

    const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/gu;
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier !== undefined) checkImport(filePath, specifier, violations);
    }
  }
  return violations;
}

describe("source boundary", () => {
  it("does not import outside src or use bare packages", () => {
    expect(scanSourceTree(sourceRoot)).toEqual([]);
  });

  it("keeps runtime dependencies empty and dev dependencies narrow", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies ?? {}).toEqual({});
    expect(Object.keys(packageJson.devDependencies ?? {}).sort()).toEqual([
      "@types/node",
      "typescript",
      "vitest",
    ]);
  });
});
