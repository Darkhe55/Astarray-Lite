import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
) as {
  name: string;
  private: boolean;
  files: string[];
  exports: Record<string, unknown>;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  engines: { node: string };
};

describe("package contract", () => {
  it("packs only built output, never local docs or tests", () => {
    expect(packageJson.name).toBe("astarray-lite");
    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.files).not.toContain("src");
    expect(packageJson.files).not.toContain("tests");
    expect(packageJson.files).not.toContain([".local", "docs"].join("-"));
  });

  it("keeps the public entry and dependency surface narrow", () => {
    expect(packageJson.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    });
    expect(packageJson.dependencies ?? {}).toEqual({});
    expect(packageJson.engines.node).toBe(">=20");
    expect(packageJson.bin).toEqual({ "astarray-lite": "./dist/cli/main.js" });
  });
});
