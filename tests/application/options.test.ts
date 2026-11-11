import { describe, expect, it } from "vitest";

import { LiteError } from "../../src/contracts/errors.js";
import { validateLiteApplicationOptions } from "../../src/application/options.js";

const validOptions = {
  kernel: "lite" as const,
  stateDirectory: ".astarray-lite",
  workspaceRootPath: ".",
};

describe("validateLiteApplicationOptions", () => {
  it("accepts a minimal valid configuration", () => {
    expect(validateLiteApplicationOptions(validOptions)).toBe(validOptions);
  });

  it("accepts optional project and session identifiers", () => {
    const options = {
      ...validOptions,
      projectIdentifier: "project-1",
      sessionId: "session-1",
      kernelOptions: {
        listenerTickIntervalMilliseconds: 3000,
        contextTokenBudget: 64000,
      },
    };
    expect(validateLiteApplicationOptions(options)).toBe(options);
  });

  it("rejects an empty state directory", () => {
    expect(() =>
      validateLiteApplicationOptions({ ...validOptions, stateDirectory: "  " }),
    ).toThrow(LiteError);
  });

  it("rejects an empty workspace root", () => {
    expect(() =>
      validateLiteApplicationOptions({ ...validOptions, workspaceRootPath: "" }),
    ).toThrow(LiteError);
  });

  it("rejects a non-lite kernel at runtime", () => {
    const options = { ...validOptions, kernel: "core" } as unknown as typeof validOptions;
    expect(() => validateLiteApplicationOptions(options)).toThrow(LiteError);
  });

  it("rejects an invalid listener tick", () => {
    expect(() =>
      validateLiteApplicationOptions({
        ...validOptions,
        kernelOptions: { listenerTickIntervalMilliseconds: 99 },
      }),
    ).toThrow(LiteError);
  });

  it("rejects an invalid context budget", () => {
    expect(() =>
      validateLiteApplicationOptions({
        ...validOptions,
        kernelOptions: { contextTokenBudget: 1024 },
      }),
    ).toThrow(LiteError);
  });
});
