import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../../contracts/errors.js";

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".git-credentials",
  "id_rsa",
  "id_ed25519",
]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export function isSensitiveFilePath(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  if (basename.startsWith(".env.")) return true;
  return SENSITIVE_EXTENSIONS.has(path.extname(basename));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves a workspace-relative path and verifies that neither the path text
 * nor any existing symlink ancestor escapes the workspace.
 */
export async function resolveWorkspacePath(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}): Promise<string> {
  const relativePath = input.relativePath;
  if (relativePath.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "path must be non-empty");
  }
  if (path.isAbsolute(relativePath) || WINDOWS_ABSOLUTE.test(relativePath)) {
    throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "path must be workspace-relative");
  }
  if (relativePath.includes("\0")) {
    throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "path contains a NUL byte");
  }

  const segments = relativePath.replace(/\\/gu, "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "path must not traverse parents");
  }

  const root = path.resolve(input.workspaceRoot);
  const realRoot = await fs.realpath(root);
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) {
    throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "path escapes the workspace");
  }

  let ancestor = target;
  for (;;) {
    try {
      const realAncestor = await fs.realpath(ancestor);
      if (!isInside(realRoot, realAncestor)) {
        throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "path escapes the workspace");
      }
      break;
    } catch (error) {
      if (error instanceof LiteError) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "path has no workspace ancestor");
      }
      ancestor = parent;
    }
  }

  return target;
}

export function assertNotSensitivePath(filePath: string): void {
  if (isSensitiveFilePath(filePath)) {
    throw new LiteError("LITE_SENSITIVE_CONTENT_BLOCKED", "sensitive file access is blocked");
  }
}

export function assertNotStatePath(filePath: string, stateRoot: string): void {
  const root = path.resolve(stateRoot);
  const target = path.resolve(filePath);
  if (isInside(root, target)) {
    throw new LiteError(
      "LITE_PATH_OUT_OF_WORKSPACE",
      "kernel state directory is not accessible to workspace tools",
    );
  }
}
