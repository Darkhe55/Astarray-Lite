import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveLitePaths, type LitePaths } from "../../src/persistence/lite-paths.js";
import { recoverLiteState } from "../../src/persistence/recovery.js";
import { writeJsonAtomic } from "../../src/persistence/state-store.js";
import { TaskSequenceStore } from "../../src/tasks/task-sequence-store.js";
import { createEmptyTaskSequence, insertTask } from "../../src/tasks/task-sequence.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function paths(): Promise<LitePaths> {
  const workspace = await createTestDirectory("recovery");
  directories.push(workspace);
  return resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("recoverLiteState", () => {
  it("creates a minimal state and sequence for a fresh workspace", async () => {
    const litePaths = await paths();
    const report = await recoverLiteState({ paths: litePaths, now: () => new Date(now) });
    expect(report.healthy).toBe(true);
    expect(await exists(litePaths.stateFile)).toBe(true);
    expect(await exists(litePaths.sequenceFile)).toBe(true);
    expect(report.actions.map((action) => action.target)).toEqual([
      "state",
      "sequence",
      "inbox",
    ]);
  });

  it("does not write files in dry-run mode", async () => {
    const litePaths = await paths();
    const report = await recoverLiteState({
      paths: litePaths,
      now: () => new Date(now),
      isDryRun: true,
    });
    expect(report.healthy).toBe(true);
    expect(await exists(litePaths.stateFile)).toBe(false);
    expect(await exists(litePaths.sequenceFile)).toBe(false);
  });

  it("restores a corrupt state primary from backup", async () => {
    const litePaths = await paths();
    await writeJsonAtomic(litePaths.stateFile, litePaths.stateBackupFile, {
      schemaVersion: 1,
      revision: 1,
      status: "booting",
      updatedAtIso: now,
    });
    await writeJsonAtomic(litePaths.stateFile, litePaths.stateBackupFile, {
      schemaVersion: 1,
      revision: 2,
      status: "idle",
      updatedAtIso: now,
    });
    await writeFile(litePaths.stateFile, "{broken", "utf8");

    const report = await recoverLiteState({ paths: litePaths, now: () => new Date(now) });
    expect(report.actions).toContainEqual(
      expect.objectContaining({ target: "state", action: "restored-from-backup" }),
    );
  });

  it("restores a corrupt sequence primary from backup", async () => {
    const litePaths = await paths();
    const store = new TaskSequenceStore(litePaths);
    const empty = createEmptyTaskSequence(now);
    await store.write(empty);
    await store.write(insertTask(empty, "task-1", { kind: "bottom" }, now));
    await writeFile(litePaths.sequenceFile, "{broken", "utf8");

    const report = await recoverLiteState({ paths: litePaths, now: () => new Date(now) });
    expect(report.actions).toContainEqual(
      expect.objectContaining({ target: "sequence", action: "restored-from-backup" }),
    );
  });

  it("fails closed on a corrupt inbox journal", async () => {
    const litePaths = await paths();
    await mkdir(path.dirname(litePaths.inboxJournalFile), { recursive: true });
    await writeFile(litePaths.inboxJournalFile, "not-json\n", "utf8");
    await expect(
      recoverLiteState({ paths: litePaths, now: () => new Date(now) }),
    ).rejects.toMatchObject({ code: "LITE_RECOVERY_REQUIRED" });
  });
});
