import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../contracts/errors.js";
import { sha256Hex } from "../context/hash.js";
import type { CredentialStore } from "./credential-store.js";

const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$secret = $env:DPAPI_SECRET",
  "$bytes = [Text.Encoding]::UTF8.GetBytes($secret)",
  "$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[IO.File]::WriteAllText($env:DPAPI_OUT, [Convert]::ToBase64String($protected))",
].join("; ");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$blob = [Convert]::FromBase64String([IO.File]::ReadAllText($env:DPAPI_FILE))",
  "$bytes = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[IO.File]::WriteAllText($env:DPAPI_OUT, [Text.Encoding]::UTF8.GetString($bytes))",
].join("; ");

export interface WindowsCredentialStoreOptions {
  readonly directory: string;
  readonly protect?: (secret: string) => Promise<string>;
  readonly unprotect?: (blob: string) => Promise<string>;
}

/**
 * DPAPI-backed credential store. The encrypted blob can only be decrypted by
 * the same Windows user; plaintext never touches disk or command-line args.
 */
export class WindowsDpapiCredentialStore implements CredentialStore {
  private readonly directory: string;
  private readonly protectImpl: (secret: string) => Promise<string>;
  private readonly unprotectImpl: (blob: string) => Promise<string>;

  constructor(options: WindowsCredentialStoreOptions) {
    this.directory = options.directory;
    this.protectImpl = options.protect ?? defaultProtect;
    this.unprotectImpl = options.unprotect ?? defaultUnprotect;
  }

  async get(reference: string): Promise<string | undefined> {
    const filePath = this.fileFor(reference);
    let blob: string;
    try {
      blob = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return undefined;
      throw new LiteError("LITE_INVALID_ARGUMENT", "credential could not be read");
    }
    try {
      return await this.unprotectImpl(blob.trim());
    } catch {
      throw new LiteError("LITE_INVALID_ARGUMENT", "credential could not be decrypted");
    }
  }

  async set(reference: string, secret: string): Promise<void> {
    if (secret === "") {
      throw new LiteError("LITE_INVALID_ARGUMENT", "secret must be non-empty");
    }
    const blob = await this.protectImpl(secret);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filePath = this.fileFor(reference);
    const temporary = `${filePath}.tmp`;
    try {
      await fs.writeFile(temporary, blob, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, filePath);
    } catch {
      await fs.rm(temporary, { force: true });
      throw new LiteError("LITE_INVALID_ARGUMENT", "credential could not be stored");
    }
  }

  async delete(reference: string): Promise<void> {
    await fs.rm(this.fileFor(reference), { force: true });
  }

  private fileFor(reference: string): string {
    return path.join(this.directory, `${sha256Hex(reference)}.dpapi`);
  }
}

async function runPowerShell(script: string, environment: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        env: { ...process.env, ...environment },
        windowsHide: true,
        stdio: "ignore",
      },
    );
    child.once("error", () => reject(new LiteError("LITE_INVALID_ARGUMENT", "Windows credential operation failed")));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new LiteError("LITE_INVALID_ARGUMENT", "Windows credential operation failed"));
    });
  });
}

function temporaryPath(label: string): string {
  return path.join(
    process.env["TEMP"] ?? process.env["TMP"] ?? ".",
    `astarray-dpapi-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
}

async function defaultProtect(secret: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "DPAPI is only available on Windows");
  }
  const output = temporaryPath("out");
  try {
    await runPowerShell(PROTECT_SCRIPT, { DPAPI_SECRET: secret, DPAPI_OUT: output });
    return (await fs.readFile(output, "utf8")).trim();
  } finally {
    await fs.rm(output, { force: true });
  }
}

async function defaultUnprotect(blob: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "DPAPI is only available on Windows");
  }
  const input = temporaryPath("in");
  const output = temporaryPath("out");
  await fs.writeFile(input, blob, { encoding: "utf8", mode: 0o600 });
  try {
    await runPowerShell(UNPROTECT_SCRIPT, { DPAPI_FILE: input, DPAPI_OUT: output });
    return await fs.readFile(output, "utf8");
  } finally {
    await fs.rm(input, { force: true });
    await fs.rm(output, { force: true });
  }
}
