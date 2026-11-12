import { promises as fs } from "node:fs";

import { LiteError } from "../contracts/errors.js";
import type { LitePermissionProfile } from "../permissions/capabilities.js";
import { writeJsonAtomic } from "../persistence/state-store.js";
import { OpenAiImageProvider } from "../runtime/image-provider.js";
import {
  createProviderFromCredential,
  type CredentialStore,
} from "./credential-store.js";
import {
  createProductKernel,
  type LiteApprovalDecision,
  type ProductApprovalRequest,
  type ProductKernel,
} from "./product-kernel.js";

export interface ProductProviderConfig {
  readonly providerId?: string;
  readonly baseUrl: string;
  readonly modelIdentifier: string;
  readonly timeoutMilliseconds?: number;
}

export interface ProductImageConfig {
  readonly baseUrl?: string;
  readonly modelIdentifier: string;
}

export interface ProductConfigV1 {
  readonly schemaVersion: 1;
  readonly provider: ProductProviderConfig;
  readonly credentialReference: string;
  readonly profile: LitePermissionProfile;
  readonly maxOutputTokens?: number;
  readonly image?: ProductImageConfig;
  readonly telemetry?: "off" | "anonymous";
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${label} must be a non-empty string`);
  }
  return value;
}

export function parseProductConfig(value: unknown): ProductConfigV1 {
  const record = assertObject(value, "config");
  if (record["schemaVersion"] !== 1) {
    throw new LiteError("LITE_SCHEMA_UNSUPPORTED", "unsupported product config schema");
  }
  if (record["apiKey"] !== undefined) {
    throw new LiteError(
      "LITE_INVALID_ARGUMENT",
      "config must not contain apiKey; use credentialReference",
    );
  }
  const provider = assertObject(record["provider"], "provider");
  if (provider["apiKey"] !== undefined) {
    throw new LiteError(
      "LITE_INVALID_ARGUMENT",
      "provider must not contain apiKey; use credentialReference",
    );
  }
  const profile = record["profile"];
  if (profile !== "safe" && profile !== "balanced" && profile !== "trusted") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "profile must be safe, balanced or trusted");
  }
  const image =
    record["image"] === undefined
      ? undefined
      : (() => {
          const imageRecord = assertObject(record["image"], "image");
          return {
            ...(imageRecord["baseUrl"] === undefined
              ? {}
              : { baseUrl: assertString(imageRecord["baseUrl"], "image.baseUrl") }),
            modelIdentifier: assertString(imageRecord["modelIdentifier"], "image.modelIdentifier"),
          };
        })();
  const telemetry = record["telemetry"];
  if (telemetry !== undefined && telemetry !== "off" && telemetry !== "anonymous") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "telemetry must be off or anonymous");
  }
  return {
    schemaVersion: 1,
    provider: {
      ...(provider["providerId"] === undefined
        ? {}
        : { providerId: assertString(provider["providerId"], "provider.providerId") }),
      baseUrl: assertString(provider["baseUrl"], "provider.baseUrl"),
      modelIdentifier: assertString(provider["modelIdentifier"], "provider.modelIdentifier"),
      ...(provider["timeoutMilliseconds"] === undefined
        ? {}
        : {
            timeoutMilliseconds: (() => {
              const value = provider["timeoutMilliseconds"];
              if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
                throw new LiteError("LITE_INVALID_ARGUMENT", "timeoutMilliseconds must be positive");
              }
              return value;
            })(),
          }),
    },
    credentialReference: assertString(record["credentialReference"], "credentialReference"),
    profile,
    ...(record["maxOutputTokens"] === undefined
      ? {}
      : {
          maxOutputTokens: (() => {
            const value = record["maxOutputTokens"];
            if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
              throw new LiteError("LITE_INVALID_ARGUMENT", "maxOutputTokens must be positive");
            }
            return value;
          })(),
        }),
    ...(image === undefined ? {} : { image }),
    ...(telemetry === undefined ? {} : { telemetry }),
  };
}

export async function loadProductConfig(filePath: string): Promise<ProductConfigV1> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    throw new LiteError("LITE_INVALID_ARGUMENT", "product config file could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LiteError("LITE_STATE_CORRUPT", "product config is not valid JSON");
  }
  return parseProductConfig(parsed);
}

export async function saveProductConfig(
  filePath: string,
  config: ProductConfigV1,
): Promise<void> {
  const validated = parseProductConfig(config);
  await writeJsonAtomic(filePath, `${filePath}.bak`, validated);
}

export async function createProductKernelFromConfig(input: {
  readonly workspaceRootPath: string;
  readonly configPath: string;
  readonly credentialStore: CredentialStore;
  readonly sessionId: string;
  readonly projectIdentifier: string;
  readonly approvalHandler?: (request: ProductApprovalRequest) => Promise<LiteApprovalDecision>;
}): Promise<ProductKernel> {
  const config = await loadProductConfig(input.configPath);
  const provider = await createProviderFromCredential(input.credentialStore, {
    reference: config.credentialReference,
    baseUrl: config.provider.baseUrl,
    modelIdentifier: config.provider.modelIdentifier,
    ...(config.provider.providerId === undefined ? {} : { providerId: config.provider.providerId }),
    ...(config.provider.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: config.provider.timeoutMilliseconds }),
  });
  const imageKey = await input.credentialStore.get(config.credentialReference);
  const imageProvider =
    config.image === undefined || imageKey === undefined
      ? undefined
      : new OpenAiImageProvider({
          baseUrl: config.image.baseUrl ?? config.provider.baseUrl,
          apiKey: imageKey,
          modelIdentifier: config.image.modelIdentifier,
        });
  return createProductKernel({
    workspaceRootPath: input.workspaceRootPath,
    sessionId: input.sessionId,
    projectIdentifier: input.projectIdentifier,
    provider,
    profile: config.profile,
    ...(imageProvider === undefined ? {} : { imageProvider }),
    ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens }),
    ...(input.approvalHandler === undefined ? {} : { approvalHandler: input.approvalHandler }),
  });
}
