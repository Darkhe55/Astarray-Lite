import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));

if (!Array.isArray(packageJson.files) || packageJson.files.length !== 1 || packageJson.files[0] !== "dist") {
  throw new Error("package.json files must be exactly ['dist']");
}

const distRoot = path.join(repositoryRoot, "dist");
const required = ["index.js", "index.d.ts", "cli/main.js"];
for (const relativePath of required) {
  await fs.access(path.join(distRoot, relativePath));
}

async function collect(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(absolutePath)));
    } else if (entry.isFile()) {
      files.push(path.relative(repositoryRoot, absolutePath).replace(/\\/gu, "/"));
    }
  }
  return files;
}

const files = await collect(distRoot);
const forbidden = files.filter((file) => /(^|\/)(src|tests|schemas)\//u.test(file) || file.includes("local-docs"));
if (forbidden.length > 0) {
  throw new Error(`package would include non-publishable files: ${forbidden.join(", ")}`);
}

process.stdout.write(`verified package surface: ${files.length} dist files, no source or local docs\n`);
