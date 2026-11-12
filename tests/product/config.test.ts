import { afterEach, describe, expect, it } from "vitest";

import { InMemoryCredentialStore } from "../../src/product/credential-store.js";
import {
  createProductKernelFromConfig,
  loadProductConfig,
  parseProductConfig,
  saveProductConfig,
} from "../../src/product/config.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

const valid = {
  schemaVersion: 1 as const,
  provider: { baseUrl: "https://example.test/v1", modelIdentifier: "gpt-test" },
  credentialReference: "openai",
  profile: "balanced" as const,
  maxOutputTokens: 1024,
  image: { modelIdentifier: "gpt-image-1" },
};

describe("product config", () => {
  it("parses and saves a key-free config", async () => {
    expect(parseProductConfig(valid)).toEqual(valid);
    expect(parseProductConfig({ ...valid, telemetry: "off" })).toMatchObject({ telemetry: "off" });
    const workspace = await createTestDirectory("product-config");
    directories.push(workspace);
    const file = `${workspace}/product.json`;
    await saveProductConfig(file, valid);
    expect(await loadProductConfig(file)).toEqual(valid);
  });

  it("rejects plaintext keys and invalid profiles", () => {
    expect(() => parseProductConfig({ ...valid, apiKey: "dummy" })).toThrow(/credentialReference/u);
    expect(() =>
      parseProductConfig({ ...valid, provider: { ...valid.provider, apiKey: "dummy" } }),
    ).toThrow(/credentialReference/u);
    expect(() => parseProductConfig({ ...valid, profile: "root" })).toThrow(/profile/u);
    expect(() => parseProductConfig({ ...valid, telemetry: "always" })).toThrow(/telemetry/u);
  });

  it("fails closed when the credential is absent", async () => {
    const workspace = await createTestDirectory("product-config-key");
    directories.push(workspace);
    const file = `${workspace}/product.json`;
    await saveProductConfig(file, valid);
    await expect(
      createProductKernelFromConfig({
        workspaceRootPath: workspace,
        configPath: file,
        credentialStore: new InMemoryCredentialStore(),
        sessionId: "s",
        projectIdentifier: "p",
      }),
    ).rejects.toMatchObject({ code: "LITE_PROVIDER_AUTH_FAILED" });
  });
});
