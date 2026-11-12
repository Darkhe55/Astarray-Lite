import { createPublicKey, verify } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../contracts/errors.js";
import { sha256Buffer } from "../context/hash.js";

export type UpdateChannel = "stable" | "beta";

export interface UpdateManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly channel: UpdateChannel;
  readonly url: string;
  readonly sha256: string;
  readonly signature: string;
}

export interface UpdateFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type UpdateFetch = (url: string) => Promise<UpdateFetchResponse>;

export interface UpdateDownloadResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type UpdateDownloadFetch = (url: string) => Promise<UpdateDownloadResponse>;

export type UpdateCheckResult =
  | { readonly status: "up-to-date"; readonly currentVersion: string }
  | { readonly status: "update-available"; readonly currentVersion: string; readonly manifest: UpdateManifest };

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

export function compareVersions(left: string, right: string): number {
  const leftMatch = VERSION_PATTERN.exec(left);
  const rightMatch = VERSION_PATTERN.exec(right);
  if (leftMatch === null || rightMatch === null) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "version must be semver-like");
  }
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return difference;
  }
  const leftPre = leftMatch[4];
  const rightPre = rightMatch[4];
  if (leftPre === rightPre) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  return leftPre.localeCompare(rightPre);
}

function manifestPayload(manifest: UpdateManifest): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      version: manifest.version,
      channel: manifest.channel,
      url: manifest.url,
      sha256: manifest.sha256,
    }),
    "utf8",
  );
}

export function verifyUpdateManifest(manifest: UpdateManifest, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(
      null,
      manifestPayload(manifest),
      key,
      Buffer.from(manifest.signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function parseUpdateManifest(value: unknown): UpdateManifest {
  if (value === null || typeof value !== "object") {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== 1) {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "unsupported update manifest schema");
  }
  const version = record["version"];
  const channel = record["channel"];
  const url = record["url"];
  const sha256 = record["sha256"];
  const signature = record["signature"];
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update version is invalid");
  }
  if (channel !== "stable" && channel !== "beta") {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update channel is invalid");
  }
  if (typeof url !== "string" || !/^https:\/\//u.test(url)) {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update url must use https");
  }
  if (typeof sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(sha256)) {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update sha256 is invalid");
  }
  if (typeof signature !== "string" || signature === "") {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update signature is required");
  }
  return { schemaVersion: 1, version, channel, url, sha256, signature };
}

export async function checkForUpdate(input: {
  readonly currentVersion: string;
  readonly manifestUrl: string;
  readonly publicKeyPem: string;
  readonly fetchImpl?: UpdateFetch;
  readonly channel?: UpdateChannel;
}): Promise<UpdateCheckResult> {
  if (!/^https:\/\//u.test(input.manifestUrl)) {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "manifest url must use https");
  }
  const fetchImpl =
    input.fetchImpl ?? (async (url: string) => fetch(url) as unknown as Promise<UpdateFetchResponse>);
  let response: UpdateFetchResponse;
  try {
    response = await fetchImpl(input.manifestUrl);
  } catch {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update manifest fetch failed");
  }
  if (!response.ok) {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update manifest request failed");
  }
  const manifest = parseUpdateManifest(await response.json());
  if (!verifyUpdateManifest(manifest, input.publicKeyPem)) {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update manifest signature is invalid");
  }
  if (input.channel !== undefined && manifest.channel !== input.channel) {
    return { status: "up-to-date", currentVersion: input.currentVersion };
  }
  if (compareVersions(manifest.version, input.currentVersion) <= 0) {
    return { status: "up-to-date", currentVersion: input.currentVersion };
  }
  return { status: "update-available", currentVersion: input.currentVersion, manifest };
}

export async function downloadUpdate(input: {
  readonly manifest: UpdateManifest;
  readonly directory: string;
  readonly fetchImpl?: UpdateDownloadFetch;
}): Promise<string> {
  if (!/^https:\/\//u.test(input.manifest.url)) {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update url must use https");
  }
  const fetchImpl =
    input.fetchImpl ??
    (async (url: string) => fetch(url) as unknown as Promise<UpdateDownloadResponse>);
  let response: UpdateDownloadResponse;
  try {
    response = await fetchImpl(input.manifest.url);
  } catch {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update download failed");
  }
  if (!response.ok) {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update download request failed");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256Buffer(bytes) !== input.manifest.sha256) {
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "update payload hash does not match");
  }
  const rawName = path.basename(new URL(input.manifest.url).pathname);
  const filename = rawName === "" || rawName === "." || rawName === ".." ? "update.tgz" : rawName;
  await fs.mkdir(input.directory, { recursive: true });
  const target = path.join(input.directory, filename);
  const temporary = `${target}.download`;
  try {
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, target);
  } catch {
    await fs.rm(temporary, { force: true });
    throw new LiteError("LITE_UPDATE_MANIFEST_INVALID", "could not write update payload");
  }
  return target;
}
