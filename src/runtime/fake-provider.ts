import type {
  LiteProvider,
  LiteProviderRequest,
  LiteProviderResponse,
} from "./provider.js";

/**
 * Scripted provider for tests and local contract probes. It never performs
 * network I/O; every response is supplied by the caller.
 */
export class FakeProvider implements LiteProvider {
  readonly providerId = "fake";
  readonly modelIdentifier = "fake-model";
  readonly requests: LiteProviderRequest[] = [];
  private readonly responses: LiteProviderResponse[];
  private readonly beforeRespond: ((request: LiteProviderRequest) => Promise<void>) | undefined;

  constructor(
    responses: readonly LiteProviderResponse[],
    options?: { readonly beforeRespond?: (request: LiteProviderRequest) => Promise<void> },
  ) {
    this.responses = [...responses];
    this.beforeRespond = options?.beforeRespond;
  }

  enqueue(response: LiteProviderResponse): void {
    this.responses.push(response);
  }

  getPendingResponseCount(): number {
    return this.responses.length;
  }

  async complete(request: LiteProviderRequest): Promise<LiteProviderResponse> {
    this.requests.push({
      ...request,
      messages: [...request.messages],
      tools: [...request.tools],
    });
    if (this.beforeRespond !== undefined) {
      await this.beforeRespond(request);
    }
    const response = this.responses.shift();
    if (response === undefined) {
      return {
        kind: "error",
        code: "LITE_PROVIDER_REQUEST_FAILED",
        message: "fake provider has no scripted response left",
        isRetryable: false,
      };
    }
    return response;
  }
}
