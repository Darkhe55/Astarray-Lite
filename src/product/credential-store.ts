import { LiteError } from "../contracts/errors.js";
import { OpenAiCompatibleProvider } from "../runtime/openai-provider.js";

/**
 * Credential boundary for the public core. Desktop/UI code can implement this
 * with the OS keychain; the core only ever sees a resolved secret in memory.
 */
export interface CredentialStore {
  get(reference: string): Promise<string | undefined>;
  set(reference: string, secret: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

export class InMemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();

  async get(reference: string): Promise<string | undefined> {
    return this.values.get(reference);
  }

  async set(reference: string, secret: string): Promise<void> {
    if (secret === "") throw new LiteError("LITE_INVALID_ARGUMENT", "secret must be non-empty");
    this.values.set(reference, secret);
  }

  async delete(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

export class EnvironmentCredentialStore implements CredentialStore {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>> = process.env) {}

  async get(reference: string): Promise<string | undefined> {
    const value = this.environment[reference];
    return value === undefined || value === "" ? undefined : value;
  }

  async set(): Promise<void> {
    throw new LiteError(
      "LITE_INVALID_ARGUMENT",
      "environment credentials are read-only; configure them in the environment",
    );
  }

  async delete(): Promise<void> {
    throw new LiteError(
      "LITE_INVALID_ARGUMENT",
      "environment credentials are read-only; configure them in the environment",
    );
  }
}

export interface CredentialProviderConfig {
  readonly reference: string;
  readonly baseUrl: string;
  readonly modelIdentifier: string;
  readonly providerId?: string;
  readonly timeoutMilliseconds?: number;
}

export async function createProviderFromCredential(
  store: CredentialStore,
  config: CredentialProviderConfig,
): Promise<OpenAiCompatibleProvider> {
  const apiKey = await store.get(config.reference);
  if (apiKey === undefined) {
    throw new LiteError(
      "LITE_PROVIDER_AUTH_FAILED",
      `credential ${config.reference} is not configured`,
    );
  }
  return new OpenAiCompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey,
    modelIdentifier: config.modelIdentifier,
    ...(config.providerId === undefined ? {} : { providerId: config.providerId }),
    ...(config.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: config.timeoutMilliseconds }),
  });
}
