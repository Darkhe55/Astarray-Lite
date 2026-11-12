import { LiteError } from "../contracts/errors.js";

export interface ImageEditRequest {
  readonly imageBase64: string;
  readonly mediaType: string;
  readonly prompt: string;
  readonly model?: string;
  readonly size?: "256x256" | "512x512" | "1024x1024" | "1536x1024" | "1024x1536";
}

export interface ImageEditResult {
  readonly dataBase64: string;
  readonly mediaType: string;
  readonly revisedPrompt?: string;
}

export interface ImageFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type ImageFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: FormData;
    readonly signal: AbortSignal;
  },
) => Promise<ImageFetchResponse>;

export interface OpenAiImageProviderOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelIdentifier?: string;
  readonly fetchImpl?: ImageFetch;
  readonly timeoutMilliseconds?: number;
}

/**
 * Image editing adapter for OpenAI-compatible `/images/edits`. It accepts only
 * base64 responses so the product never has to fetch arbitrary remote URLs.
 */
export class OpenAiImageProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly modelIdentifier: string;
  private readonly fetchImpl: ImageFetch;
  private readonly timeoutMilliseconds: number;

  constructor(options: OpenAiImageProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.modelIdentifier = options.modelIdentifier ?? "gpt-image-1";
    this.fetchImpl =
      options.fetchImpl ??
      ((url, init) => fetch(url, init) as unknown as Promise<ImageFetchResponse>);
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 180_000;
  }

  async edit(request: ImageEditRequest): Promise<ImageEditResult> {
    const form = new FormData();
    form.append("model", request.model ?? this.modelIdentifier);
    form.append("prompt", request.prompt);
    form.append("size", request.size ?? "1024x1024");
    form.append(
      "image",
      new Blob([Buffer.from(request.imageBase64, "base64")], { type: request.mediaType }),
      "image",
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/images/edits`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new LiteError(
          "LITE_IMAGE_PROVIDER_FAILED",
          response.status === 429 ? "image provider rate limit" : "image provider request failed",
        );
      }
      const body = (await response.json()) as {
        readonly data?: readonly {
          readonly b64_json?: string;
          readonly revised_prompt?: string;
        }[];
      };
      const first = body.data?.[0];
      if (first?.b64_json === undefined || first.b64_json === "") {
        throw new LiteError("LITE_IMAGE_PROVIDER_FAILED", "image provider returned no image data");
      }
      return {
        dataBase64: first.b64_json,
        mediaType: "image/png",
        ...(first.revised_prompt === undefined ? {} : { revisedPrompt: first.revised_prompt }),
      };
    } catch (error) {
      if (error instanceof LiteError) throw error;
      throw new LiteError("LITE_IMAGE_PROVIDER_FAILED", "image provider transport failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
