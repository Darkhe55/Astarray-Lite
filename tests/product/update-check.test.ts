import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  checkForUpdate,
  compareVersions,
  parseUpdateManifest,
  verifyUpdateManifest,
  type UpdateManifest,
} from "../../src/product/update-check.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function manifest(version = "1.1.0", channel: "stable" | "beta" = "stable"): UpdateManifest {
  const unsigned = {
    schemaVersion: 1 as const,
    version,
    channel,
    url: "https://example.test/astarray-lite.tgz",
    sha256: `sha256:${"a".repeat(64)}`,
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
});
