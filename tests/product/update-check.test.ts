import { generateKeyPairSync, sign } from "node:crypto";
import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  checkForUpdate,
  compareVersions,
  downloadUpdate,
  parseUpdateManifest,
  verifyUpdateManifest,
  type UpdateManifest,
} from "../../src/product/update-check.js";
import { sha256Buffer } from "../../src/context/hash.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function manifest(version = "1.1.0", channel: "stable" | "beta" = "stable", sha256 = `sha256:${"a".repeat(64)}`): UpdateManifest {
  const unsigned = {
    schemaVersion: 1 as const,
    version,
    channel,
    url: "https://example.test/astarray-lite.tgz",
    sha256,
  };
  const signature = sign(null, Buffer.from(JSON.stringify(unsigned)), keys.privateKey).toString("base64");
  return { ...unsigned, signature };
}

function response(value: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

describe("update manifest", () => {
  it("verifies signed manifests and compares versions", async () => {
    const signed = manifest();
    expect(verifyUpdateManifest(signed, publicKeyPem)).toBe(true);
    expect(compareVersions("1.1.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    const result = await checkForUpdate({
      currentVersion: "1.0.0",
      manifestUrl: "https://example.test/update.json",
      publicKeyPem,
      fetchImpl: async () => response(signed),
    });
    expect(result).toMatchObject({ status: "update-available", manifest: { version: "1.1.0" } });
  });

  it("rejects tampered manifests", async () => {
    const signed = { ...manifest(), version: "9.9.9" };
    expect(verifyUpdateManifest(signed, publicKeyPem)).toBe(false);
    await expect(
      checkForUpdate({
        currentVersion: "1.0.0",
        manifestUrl: "https://example.test/update.json",
        publicKeyPem,
        fetchImpl: async () => response(signed),
      }),
    ).rejects.toMatchObject({ code: "LITE_UPDATE_MANIFEST_INVALID" });
  });

  it("rejects insecure URLs and malformed fields", () => {
    expect(() =>
      parseUpdateManifest({ ...manifest(), url: "http://example.test/app.tgz" }),
    ).toThrow(/https/u);
    expect(() => parseUpdateManifest({ ...manifest(), sha256: "bad" })).toThrow(/sha256/u);
  });

  it("downloads and verifies the signed payload", async () => {
    const workspace = await createTestDirectory("update-download");
    try {
      const bytes = Buffer.from("update payload");
      const signed = manifest("1.1.0", "stable", sha256Buffer(bytes));
      const target = await downloadUpdate({
        manifest: signed,
        directory: workspace,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        }),
      });
      expect(await fs.readFile(target)).toEqual(bytes);
      await expect(
        downloadUpdate({
          manifest: signed,
          directory: workspace,
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode("tampered").buffer,
          }),
        }),
      ).rejects.toMatchObject({ code: "LITE_UPDATE_MANIFEST_INVALID" });
    } finally {
      await removeTestDirectory(workspace);
    }
  });
});
