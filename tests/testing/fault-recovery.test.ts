import { afterEach, describe, expect, it } from "vitest";

import { resolveLitePaths } from "../../src/persistence/lite-paths.js";
import { readJsonWithBackup, writeJsonAtomic } from "../../src/persistence/state-store.js";
import { FaultInjector, withFaultPoint } from "../../src/testing/fault-injection.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

describe("fault recovery", () => {
  it("leaves the previous state intact after an injected write fault", async () => {
    const workspace = await createTestDirectory("fault-recovery");
    directories.push(workspace);
    const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
    await writeJsonAtomic(paths.stateFile, paths.stateBackupFile, { revision: 1 });

    const injector = new FaultInjector({
      "state-write-before-temp": { action: "throw", times: 1 },
    });
    await expect(
      withFaultPoint(injector, "state-write-before-temp", () =>
        writeJsonAtomic(paths.stateFile, paths.stateBackupFile, { revision: 2 }),
      ),
    ).rejects.toMatchObject({ point: "state-write-before-temp" });

    const current = await readJsonWithBackup<{ revision: number }>(
      paths.stateFile,
      paths.stateBackupFile,
    );
    expect(current?.value.revision).toBe(1);

    await withFaultPoint(injector, "state-write-before-temp", () =>
      writeJsonAtomic(paths.stateFile, paths.stateBackupFile, { revision: 2 }),
    );
    const recovered = await readJsonWithBackup<{ revision: number }>(
      paths.stateFile,
      paths.stateBackupFile,
    );
    expect(recovered?.value.revision).toBe(2);
  });
});
