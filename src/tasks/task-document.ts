import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../contracts/errors.js";
import { assertSafePathSegment, type LitePaths } from "../persistence/lite-paths.js";
import { writeJsonAtomic } from "../persistence/state-store.js";
import type { LiteTaskRecord } from "./task-record.js";

export interface TaskRecalledFile {
  readonly path: string;
  readonly contentHash: string;
}

export interface TaskDocumentOptions {
  readonly stateRootLabel?: string;
  readonly sourceExcerpt?: string;
  readonly transcriptPath?: string;
  readonly transcriptLineRange?: readonly [number, number];
  readonly recalledFiles?: readonly TaskRecalledFile[];
  readonly decisions?: readonly string[];
  readonly openQuestions?: readonly string[];
}

export interface TaskDocumentPaths {
  readonly taskDirectory: string;
  readonly taskJsonPath: string;
  readonly taskMarkdownPath: string;
  readonly contextMarkdownPath: string;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function bulletList(values: readonly string[], empty: string): string {
  if (values.length === 0) return `- ${empty}`;
  return values.map((value) => `- ${value}`).join("\n");
}

/**
 * Renders the model-readable task document. The document is deterministic for
 * a given record and options; it contains no absolute paths or clock reads.
 */
export function renderTaskMarkdown(
  record: LiteTaskRecord,
  options: TaskDocumentOptions = {},
): string {
  const stateRootLabel = options.stateRootLabel ?? ".astarray-lite";
  const sourceMessage = record.source.messageId;
  const sourceLine =
    sourceMessage === undefined
      ? "- Source message: （无）"
      : `- Source message: ${sourceMessage}（原文见 \`${stateRootLabel}/archive/user-messages/${sourceMessage}.json\`）`;
  const transcriptLine =
    options.transcriptPath === undefined
      ? "- Source transcript: （无）"
      : `- Source transcript: \`${options.transcriptPath}${
          options.transcriptLineRange === undefined
            ? ""
            : `#L${options.transcriptLineRange[0]}-L${options.transcriptLineRange[1]}`
        }\``;

  const criteria =
    record.acceptanceCriteria.length === 0
      ? "- （无）"
      : record.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join("\n");
  const progress =
    record.progressNotes.length === 0
      ? "- （暂无）"
      : record.progressNotes
          .map((note) => `- ${note.atIso} [${note.turnId}] ${oneLine(note.note)}`)
          .join("\n");
  const evidence =
    record.evidence.length === 0
      ? "- （暂无）"
      : record.evidence
          .map(
            (entry) =>
              `- ${entry.kind} \`${entry.reference}\` — ${oneLine(entry.summary)}${
                entry.contentHash === undefined ? "" : ` (${entry.contentHash})`
              }`,
          )
          .join("\n");
  const recalled =
    (options.recalledFiles ?? []).length === 0
      ? "- （暂无）"
      : (options.recalledFiles ?? [])
          .map((file) => `- ${file.path} (${file.contentHash})`)
          .join("\n");

  return [
    `# ${oneLine(record.title)}`,
    "",
    `- Task ID: ${record.taskId}`,
    `- Status: ${record.status}`,
    `- Created: ${record.createdAtIso}`,
    `- Task kind: ${record.taskKind}`,
    ...(record.parentGoalId === undefined ? [] : [`- Parent goal: ${record.parentGoalId}`]),
    sourceLine,
    transcriptLine,
    "",
    "## Goal",
    record.objective,
    "",
    "## Constraints",
    bulletList(record.constraints, "（无）"),
    "",
    "## Acceptance criteria",
    criteria,
    "",
    "## Context provenance",
    `- 用户原话摘要：${oneLine(options.sourceExcerpt ?? "（未提供）")}`,
    "- 相关文件：",
    recalled,
    "- 关键决策：",
    bulletList(options.decisions ?? [], "（暂无）"),
    "",
    "## Progress",
    progress,
    "",
    "## Evidence",
    evidence,
    "",
    "## Open questions",
    bulletList(options.openQuestions ?? [], "（暂无）"),
    "",
  ].join("\n");
}

export function renderContextMarkdown(
  record: LiteTaskRecord,
  options: TaskDocumentOptions = {},
): string {
  const sourceMessage = record.source.messageId ?? "（无）";
  return [
    `# Context: ${oneLine(record.title)}`,
    "",
    `- Task ID: ${record.taskId}`,
    `- Source message: ${sourceMessage}`,
    "",
    "## Source excerpt",
    options.sourceExcerpt ?? "（未提供）",
    "",
    "## Files",
    (options.recalledFiles ?? []).length === 0
      ? "- （暂无）"
      : (options.recalledFiles ?? [])
          .map((file) => `- ${file.path} (${file.contentHash})`)
          .join("\n"),
    "",
    "## Decisions",
    bulletList(options.decisions ?? [], "（暂无）"),
    "",
    "## Open questions",
    bulletList(options.openQuestions ?? [], "（暂无）"),
    "",
  ].join("\n");
}

export function resolveTaskDocumentPaths(
  paths: LitePaths,
  taskId: string,
): TaskDocumentPaths {
  assertSafePathSegment(taskId, "taskId");
  const taskDirectory = path.join(paths.tasksDirectory, taskId);
  return {
    taskDirectory,
    taskJsonPath: path.join(taskDirectory, "task.json"),
    taskMarkdownPath: path.join(taskDirectory, "task.md"),
    contextMarkdownPath: path.join(taskDirectory, "context.md"),
  };
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, filePath);
}

export async function writeTaskDocuments(input: {
  readonly paths: LitePaths;
  readonly record: LiteTaskRecord;
  readonly options?: TaskDocumentOptions;
}): Promise<TaskDocumentPaths> {
  if (input.record.taskId === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "task id must be non-empty");
  }
  const documentPaths = resolveTaskDocumentPaths(input.paths, input.record.taskId);
  await fs.mkdir(documentPaths.taskDirectory, { recursive: true });
  await writeJsonAtomic(
    documentPaths.taskJsonPath,
    `${documentPaths.taskJsonPath}.bak`,
    input.record,
  );
  await writeTextAtomic(
    documentPaths.taskMarkdownPath,
    renderTaskMarkdown(input.record, input.options),
  );
  await writeTextAtomic(
    documentPaths.contextMarkdownPath,
    renderContextMarkdown(input.record, input.options),
  );
  return documentPaths;
}
