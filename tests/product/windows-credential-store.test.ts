import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WindowsDpapiCredentialStore } from "../../src/product/windows-credential-store.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

function fakeStore(directory: string) {
  return new WindowsDpapiCredentialStore({
    directory,
    protect: async (secret) => Buffer.from(secret, "utf8").toString("base64"),
    unprotect: async (blob) => Buffer.from(blob, "base64").toString("utf8"),
  });
}

describe("WindowsDpapiCredentialStore", () => {
  it("stores an encrypted blob and resolves it by reference", async () => {
    const workspace = await createTestDirectory("dpapi-store");
    directories.push(workspace);
    const store = fakeStore(workspace);
    await store.set("ASTRARRAY_LITE_API_KEY", "dummy-secret");
    expect(await store.get("ASTRARRAY_LITE_API_KEY")).toBe("dummy-secret");
    const files = await fs.readdir(workspace);
    expect(files).toHaveLength(1);
    expect(await fs.readFile(path.join(workspace, files[0] ?? ""), "utf8")).not.toContain("dummy-secret");
    await store.delete("ASTRARRAY_LITE_API_KEY");
    expect(await store.get("ASTRARRAY_LITE_API_KEY")).toBeUndefined();
  });

  it("returns undefined for unknown references and rejects failed decryption", async () => {
    const workspace = await createTestDirectory("dpapi-store-missing");
    directories.push(workspace);
    const store = fakeStore(workspace);
    expect(await store.get("missing")).toBeUndefined();
    await store.set("broken", "secret");
    const broken = new WindowsDpapiCredentialStore({
      directory: workspace,
      unprotect: async () => {
        throw new Error("bad");
      },
    });
    await expect(broken.get("broken")).rejects.toMatchObject({ code: "LITE_INVALID_ARGUMENT" });
  });
});
