import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { resolveLitePaths } from "../../src/persistence/lite-paths.js";
import { TaskSequenceStore } from "../../src/tasks/task-sequence-store.js";
import { createEmptyTaskSequence, insertTask } from "../../src/tasks/task-sequence.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function store(): Promise<{
  readonly store: TaskSequenceStore;
  readonly sequenceFile: string;
}> {
  const workspace = await createTestDirectory("sequence");
  directories.push(workspace);
  const paths = resolveLitePaths({
    stateDirectory: ".astarray-lite",
    workspaceRootPath: workspace,
  });
  return { store: new TaskSequenceStore(paths), sequenceFile: paths.sequenceFile };
}

describe("TaskSequenceStore", () => {
  it("returns an empty sequence when the file is missing", async () => {
    const { store: sequenceStore } = await store();
    const sequence = await sequenceStore.read();
    expect(sequence.activeTaskId).toBeNull();
    expect(sequence.pendingTaskIds).toEqual([]);
  });

  it("initializes, writes and reads a sequence", async () => {
    const { store: sequenceStore } = await store();
    const empty = await sequenceStore.initialize(now);
    expect(await sequenceStore.read()).toEqual(empty);

    const withTask = insertTask(empty, "task-1", { kind: "bottom" }, now);
    await sequenceStore.write(withTask);
    expect(await sequenceStore.read()).toEqual(withTask);
  });

  it("recovers from the backup when the primary is corrupt", async () => {
    const { store: sequenceStore, sequenceFile } = await store();
    const empty = await sequenceStore.initialize(now);
    const withTask = insertTask(empty, "task-1", { kind: "bottom" }, now);
    await sequenceStore.write(withTask);
    await writeFile(sequenceFile, "{broken", "utf8");

    const recovered = await sequenceStore.read();
    expect(recovered).toEqual(empty);
  });

  it("rejects a structurally invalid sequence on write", async () => {
    const { store: sequenceStore } = await store();
    const invalid = {
      ...createEmptyTaskSequence(now),
      activeTaskId: "task-1",
      pendingTaskIds: ["task-1"],
    };
    await expect(sequenceStore.write(invalid)).rejects.toMatchObject({
      code: "LITE_STATE_CORRUPT",
    });
  });
});
