import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readJsonWithBackup,
  writeJsonAtomic,
} from "../../src/persistence/state-store.js";
import { createTestDirectory, removeTestDirectory } from "./test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function statePaths(): Promise<{ directory: string; file: string; backup: string }> {
  const directory = await createTestDirectory("state");
  directories.push(directory);
  const file = path.join(directory, "state.json");
  return { directory, file, backup: `${file}.bak` };
}

describe("writeJsonAtomic / readJsonWithBackup", () => {
  it("writes and reads a JSON document", async () => {
    const { file, backup } = await statePaths();
    await writeJsonAtomic(file, backup, { revision: 1, status: "idle" });
    const result = await readJsonWithBackup<{ revision: number; status: string }>(file, backup);
    expect(result).toEqual({ value: { revision: 1, status: "idle" }, source: "primary" });
  });

  it("recovers a corrupt primary from its backup", async () => {
    const { file, backup } = await statePaths();
    await writeJsonAtomic(file, backup, { revision: 1 });
    await writeJsonAtomic(file, backup, { revision: 2 });
    await writeFile(file, "{not json", "utf8");

    const result = await readJsonWithBackup<{ revision: number }>(file, backup);
    expect(result).toEqual({ value: { revision: 1 }, source: "backup" });
  });

  it("returns null when neither file exists", async () => {
    const { file, backup } = await statePaths();
    await expect(readJsonWithBackup(file, backup)).resolves.toBeNull();
  });

  it("does not leave temporary files behind", async () => {
    const { directory, file, backup } = await statePaths();
    await writeJsonAtomic(file, backup, { revision: 1 });
    const names = await readdir(directory);
    expect(names.some((name) => name.includes(".tmp"))).toBe(false);
  });

  it("keeps the final file valid under concurrent writes", async () => {
    const { file, backup } = await statePaths();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        writeJsonAtomic(file, backup, { revision: index }),
      ),
    );
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text) as { revision: number };
    expect(parsed.revision).toBeGreaterThanOrEqual(0);
    expect(parsed.revision).toBeLessThan(10);
  });

  it("rejects a non-serializable value without touching the target", async () => {
    const { file, backup } = await statePaths();
    await writeJsonAtomic(file, backup, { revision: 1 });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    await expect(writeJsonAtomic(file, backup, circular)).rejects.toMatchObject({
      code: "LITE_INVALID_ARGUMENT",
    });
    const result = await readJsonWithBackup<{ revision: number }>(file, backup);
    expect(result?.value.revision).toBe(1);
  });

  it("aborts a commit when the pre-commit guard rejects", async () => {
    const { file, backup } = await statePaths();
    await writeJsonAtomic(file, backup, { revision: 1 });
    await expect(
      writeJsonAtomic(file, backup, { revision: 2 }, {
        beforeCommit: async () => {
          throw new Error("guard rejected");
        },
      }),
    ).rejects.toMatchObject({ code: "LITE_INTERNAL_ERROR" });
    const result = await readJsonWithBackup<{ revision: number }>(file, backup);
    expect(result?.value.revision).toBe(1);
  });
});
