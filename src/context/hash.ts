import { createHash } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Buffer(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function sha256Digest(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

export function combineHashes(hashes: readonly string[]): string {
  return sha256Digest(hashes.join("\n"));
}
