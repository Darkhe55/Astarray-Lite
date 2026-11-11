import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

export async function createTestDirectory(prefix: string): Promise<string> {
  const base = path.join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, `${prefix}-`));
}

export async function removeTestDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
