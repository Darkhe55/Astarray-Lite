import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { LiteError } from "../../contracts/errors.js";

const execFileAsync = promisify(execFile);

export interface DocumentAdapterReadInput {
  readonly absolutePath: string;
  readonly extension: string;
}

/**
 * Optional adapter boundary for formats that need a converter. Commands are
 * configured by the application, never by the model, and are executed without
 * a shell so paths cannot be interpreted as shell syntax.
 */
export interface DocumentAdapter {
  readonly extensions: readonly string[];
  read(input: DocumentAdapterReadInput): Promise<string>;
}

export interface CommandReaderSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export class CommandDocumentAdapter implements DocumentAdapter {
  readonly extensions: readonly string[];
  private readonly readers: Readonly<Record<string, CommandReaderSpec>>;
  private readonly timeoutMilliseconds: number;

  constructor(options: {
    readonly readers: Readonly<Record<string, CommandReaderSpec>>;
    readonly timeoutMilliseconds?: number;
  }) {
    this.readers = options.readers;
    this.extensions = Object.keys(options.readers);
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
  }

  async read(input: DocumentAdapterReadInput): Promise<string> {
    const spec = this.readers[input.extension];
    if (spec === undefined) {
      throw new LiteError(
        "LITE_DOCUMENT_ADAPTER_MISSING",
        `no document adapter is configured for ${input.extension}`,
      );
    }
    const args = spec.args.map((argument) =>
      argument === "{input}" ? input.absolutePath : argument,
    );
    try {
      const result = await execFileAsync(spec.command, args, {
        windowsHide: true,
        timeout: this.timeoutMilliseconds,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      });
      return result.stdout;
    } catch {
      throw new LiteError("LITE_DOCUMENT_ADAPTER_MISSING", "document converter failed");
    }
  }
}
