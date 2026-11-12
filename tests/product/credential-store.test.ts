import { describe, expect, it } from "vitest";

import {
  EnvironmentCredentialStore,
  InMemoryCredentialStore,
  createProviderFromCredential,
} from "../../src/product/credential-store.js";

describe("credential store", () => {
  it("stores and deletes secrets in memory", async () => {
    const store = new InMemoryCredentialStore();
    await store.set("openai", "dummy");
    expect(await store.get("openai")).toBe("dummy");
    await store.delete("openai");
    expect(await store.get("openai")).toBeUndefined();
  });

  it("reads environment references but refuses writes", async () => {
    const store = new EnvironmentCredentialStore({ TEST_KEY: "dummy" });
    expect(await store.get("TEST_KEY")).toBe("dummy");
    await expect(store.set()).rejects.toMatchObject({ code: "LITE_INVALID_ARGUMENT" });
  });

  it("builds a provider from a resolved credential and fails closed when absent", async () => {
    const store = new InMemoryCredentialStore();
    await store.set("openai", "dummy");
    const provider = await createProviderFromCredential(store, {
      reference: "openai",
      baseUrl: "https://example.test/v1",
      modelIdentifier: "gpt-test",
    });
    expect(provider.providerId).toBe("openai");
    expect(provider.modelIdentifier).toBe("gpt-test");
    await expect(
      createProviderFromCredential(store, {
        reference: "missing",
        baseUrl: "https://example.test/v1",
        modelIdentifier: "gpt-test",
      }),
    ).rejects.toMatchObject({ code: "LITE_PROVIDER_AUTH_FAILED" });
  });
});
