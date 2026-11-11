import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LiteJournal } from "../../src/persistence/journal.js";
import { createTestDirectory, removeTestDirectory } from "./test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function journalFile(): Promise<string> {
  const directory = await createTestDirectory("journal");
  directories.push(directory);
  return path.join(directory, "journal.jsonl");
}

describe("LiteJournal", () => {
  it("returns an empty list when the journal does not exist", async () => {
    const journal = new LiteJournal(await journalFile());
    await expect(journal.readAll()).resolves.toEqual([]);
  });

  it("appends and reads events in order", async () => {
    const journal = new LiteJournal(await journalFile());
    await journal.append({ sequence: 0 });
    await journal.append({ sequence: 1 });
    await journal.append({ sequence: 2 });
    await expect(journal.readAll()).resolves.toEqual([
      { sequence: 0 },
      { sequence: 1 },
      { sequence: 2 },
    ]);
  });

  it("serializes concurrent appends", async () => {
    const journal = new LiteJournal(await journalFile());
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => journal.append({ sequence: index })),
    );
    const events = await journal.readAll<{ sequence: number }>();
    expect(events).toHaveLength(20);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(20);
  });

  it("fails closed on a malformed line", async () => {
    const file = await journalFile();
    await writeFile(file, '{"sequence":0}\nnot-json\n', "utf8");
    const journal = new LiteJournal(file);
    await expect(journal.readAll()).rejects.toMatchObject({ code: "LITE_STATE_CORRUPT" });
  });
});
