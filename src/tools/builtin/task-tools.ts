import { LiteError } from "../../contracts/errors.js";
import type { LitePaths } from "../../persistence/lite-paths.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { LiteToolHandlerResult, LiteToolSpec } from "../tool-types.js";
import type { UserTurnController } from "../../messages/user-turn.js";
import { archiveTask } from "../../tasks/task-archive.js";
import { renderTaskMarkdown, writeTaskDocuments } from "../../tasks/task-document.js";
import type { LiteTaskRecord, TaskPatch } from "../../tasks/task-record.js";
import type { TaskStore } from "../../tasks/task-store.js";
import type { TaskInsertPosition } from "../../tasks/task-sequence.js";

export interface TaskToolOptions {
  readonly paths: LitePaths;
  readonly taskStore: TaskStore;
  readonly userTurn?: UserTurnController;
  readonly now?: () => Date;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", `${key} must be a non-empty string`);
  }
  return value;
}

function stringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", `${key} must be an array of strings`);
  }
  return value as string[];
}

function compactTask(record: LiteTaskRecord): Record<string, unknown> {
  return {
    taskId: record.taskId,
    title: record.title,
    status: record.status,
    taskKind: record.taskKind,
    revision: record.revision,
    ...(record.goal === undefined ? {} : { goalState: record.goal.goalState }),
  };
}

function positionFrom(record: Record<string, unknown>): TaskInsertPosition {
  const position = record["position"];
  if (position === "top" || position === "bottom") return { kind: position };
  if (position === "before" || position === "after") {
    const taskId = record["taskId"];
    if (typeof taskId !== "string" || taskId === "") {
      throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "before/after requires taskId");
    }
    return { kind: position, taskId };
  }
  throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "position must be top, bottom, before or after");
}

function buildReadTopTool(options: TaskToolOptions): LiteToolSpec {
  return {
    name: "task_read_top",
    summary: "Load the queue head into the active task slot, optionally replacing the current task.",
    category: "task",
    toolClass: "readonly",
    isIdempotent: false,
    requiresBackup: false,
    capability: "task.manage",
    inputSchema: {
      type: "object",
      properties: { forceReplace: { type: "boolean" } },
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const task = await options.taskStore.readTop(record["forceReplace"] === true);
      return { outputText: JSON.stringify(compactTask(task)) };
    },
  };
}

function buildInsertTool(options: TaskToolOptions): LiteToolSpec {
  return {
    name: "task_insert",
    summary: "Insert a new task into the pending queue.",
    category: "task",
    toolClass: "restricted",
    isIdempotent: false,
    requiresBackup: false,
    capability: "task.manage",
    inputSchema: {
      type: "object",
      properties: {
        position: { type: "string", enum: ["top", "bottom", "before", "after"] },
        taskId: { type: "string" },
        title: { type: "string", minLength: 1 },
        objective: { type: "string", minLength: 1 },
        constraints: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        taskKind: { type: "string", enum: ["normal", "goal"] },
        parentGoalId: { type: "string" },
        sourceMessageId: { type: "string" },
        goal: {
          type: "object",
          properties: {
            situation: { type: "string", minLength: 1 },
            successCriteria: { type: "array", items: { type: "string" } },
          },
          required: ["situation", "successCriteria"],
          additionalProperties: false,
        },
      },
      required: ["position", "title", "objective"],
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const taskKind = record["taskKind"] === "goal" ? "goal" : "normal";
      const sourceMessageId =
        typeof record["sourceMessageId"] === "string" ? record["sourceMessageId"] : undefined;

      let source: LiteTaskRecord["source"] = { kind: "agent" };
      if (sourceMessageId !== undefined) {
        const active = options.userTurn?.getActive() ?? null;
        if (active === null || active.messageId !== sourceMessageId) {
          throw new LiteError("LITE_USER_MESSAGE_NOT_FOUND", "source message is not active");
        }
        source = { kind: "user", messageId: sourceMessageId };
      }

      const goalInput = asRecord(record["goal"] ?? {});
      const goal =
        taskKind === "goal"
          ? {
              goalState: "pursuing" as const,
              situation: requiredString(goalInput, "situation"),
              successCriteria: stringArray(goalInput, "successCriteria"),
              childTaskIds: [],
              reviewPolicy: { trigger: "manual" as const },
              reviewRequested: false,
              reviewCount: 0,
              noProgressReviewCount: 0,
            }
          : undefined;

      const task = await options.taskStore.insertTask(
        {
          title: requiredString(record, "title"),
          objective: requiredString(record, "objective"),
          constraints: stringArray(record, "constraints"),
          acceptanceCriteria: stringArray(record, "acceptanceCriteria"),
          taskKind,
          ...(typeof record["parentGoalId"] === "string"
            ? { parentGoalId: record["parentGoalId"] }
            : {}),
          ...(goal === undefined ? {} : { goal }),
          source,
        },
        positionFrom(record),
      );

      if (sourceMessageId !== undefined && options.userTurn !== undefined) {
        try {
          options.userTurn.recordTaskCreation([task.taskId]);
        } catch (error) {
          await options.taskStore.removeTask(task.taskId);
          throw error;
        }
      }
      return { outputText: JSON.stringify(compactTask(task)) };
    },
  };
}

function buildUpdateTool(options: TaskToolOptions): LiteToolSpec {
  return {
    name: "task_update",
    summary: "Update task content or progress with an expected revision.",
    category: "task",
    toolClass: "restricted",
    isIdempotent: false,
    requiresBackup: false,
    capability: "task.manage",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 1 },
        patch: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            objective: { type: "string", minLength: 1 },
            constraints: { type: "array", items: { type: "string" } },
            acceptanceCriteria: { type: "array", items: { type: "string" } },
            status: { type: "string", enum: ["pending", "active", "running", "blocked"] },
            blockedReason: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["taskId", "expectedRevision", "patch"],
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const patchRecord = asRecord(record["patch"]);
      const patch: TaskPatch = {
        ...(typeof patchRecord["title"] === "string" ? { title: patchRecord["title"] } : {}),
        ...(typeof patchRecord["objective"] === "string"
          ? { objective: patchRecord["objective"] }
          : {}),
        ...(patchRecord["constraints"] === undefined
          ? {}
          : { constraints: stringArray(patchRecord, "constraints") }),
        ...(patchRecord["acceptanceCriteria"] === undefined
          ? {}
          : { acceptanceCriteria: stringArray(patchRecord, "acceptanceCriteria") }),
        ...(typeof patchRecord["status"] === "string"
          ? { status: patchRecord["status"] as "pending" | "active" | "running" | "blocked" }
          : {}),
        ...(typeof patchRecord["blockedReason"] === "string"
          ? { blockedReason: patchRecord["blockedReason"] }
          : {}),
      };
      const task = await options.taskStore.updateTask({
        taskId: requiredString(record, "taskId"),
        expectedRevision: Number(record["expectedRevision"]),
        patch,
      });
      return { outputText: JSON.stringify(compactTask(task)) };
    },
  };
}

function buildReorderTool(options: TaskToolOptions): LiteToolSpec {
  return {
    name: "task_reorder",
    summary: "Reorder a pending task by index.",
    category: "task",
    toolClass: "restricted",
    isIdempotent: false,
    requiresBackup: false,
    capability: "task.manage",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: 1 },
        toIndex: { type: "integer", minimum: 0 },
      },
      required: ["taskId", "toIndex"],
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const sequence = await options.taskStore.reorderTask(
        requiredString(record, "taskId"),
        Number(record["toIndex"]),
      );
      return {
        outputText: JSON.stringify({
          activeTaskId: sequence.activeTaskId,
          pendingTaskIds: sequence.pendingTaskIds,
          revision: sequence.revision,
        }),
      };
    },
  };
}

function buildListTool(options: TaskToolOptions): LiteToolSpec {
  return {
    name: "task_list",
    summary: "List the active task and the pending queue compactly.",
    category: "task",
    toolClass: "readonly",
    isIdempotent: true,
    requiresBackup: false,
    capability: "task.manage",
    inputSchema: {
      type: "object",
      properties: { includeCompleted: { type: "boolean" } },
      additionalProperties: false,
    },
    handler: async (): Promise<LiteToolHandlerResult> => {
      return { outputText: JSON.stringify(options.taskStore.list().map(compactTask)) };
    },
  };
}

function buildCompleteTool(options: TaskToolOptions): LiteToolSpec {
  return {
    name: "task_complete",
    summary: "Complete the active task with a summary and evidence.",
    category: "task",
    toolClass: "restricted",
    isIdempotent: false,
    requiresBackup: false,
    capability: "task.manage",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", minLength: 10 },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["file", "command", "url", "note"] },
              reference: { type: "string", minLength: 1 },
              summary: { type: "string" },
            },
            required: ["kind", "reference"],
            additionalProperties: false,
          },
        },
        criteriaResults: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criterionIndex: { type: "integer", minimum: 0 },
              criterion: { type: "string" },
              result: { type: "string", enum: ["met", "unmet", "skipped"] },
              evidenceRef: { type: "string" },
            },
            required: ["result"],
            additionalProperties: false,
          },
        },
        selfAssessment: { type: "string", enum: ["good", "needs-review", "blocked"] },
      },
      required: ["summary", "selfAssessment"],
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const summary = requiredString(record, "summary");
      const evidenceInput = Array.isArray(record["evidence"]) ? record["evidence"] : [];
      const evidence = evidenceInput
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
        .map((entry) => ({
          kind: entry["kind"] as LiteTaskRecord["evidence"][number]["kind"],
          reference: String(entry["reference"] ?? ""),
          summary: String(entry["summary"] ?? ""),
        }))
        .filter((entry) => entry.reference !== "");
      const finished = await options.taskStore.finishActive({
        status: "done",
        archiveReason: "completed",
        evidence,
      });
      const markdown = renderTaskMarkdown(finished, { openQuestions: [] });
      await writeTaskDocuments({ paths: options.paths, record: finished });
      await archiveTask({
        paths: options.paths,
        record: finished,
        taskMarkdown: markdown,
        archiveReason: "completed",
        completion: {
          summary,
          evidence: evidence.map((entry) => entry.reference),
          criteriaResults: [],
          selfAssessment: (record["selfAssessment"] as "good" | "needs-review" | "blocked") ?? "good",
        },
      });
      return { outputText: JSON.stringify(compactTask(finished)) };
    },
  };
}

function buildStaleTool(options: TaskToolOptions): LiteToolSpec {
  return {
    name: "mark_task_stale",
    summary: "Archive the active task as stale or cancelled.",
    category: "task",
    toolClass: "restricted",
    isIdempotent: false,
    requiresBackup: false,
    capability: "task.manage",
    inputSchema: {
      type: "object",
      properties: {
        disposition: { type: "string", enum: ["stale", "cancelled"] },
        reason: { type: "string", minLength: 5 },
      },
      required: ["disposition", "reason"],
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const disposition = record["disposition"] === "cancelled" ? "cancelled" : "stale";
      const reason = requiredString(record, "reason");
      const finished = await options.taskStore.finishActive({
        status: disposition,
        archiveReason: disposition,
      });
      const markdown = renderTaskMarkdown(finished);
      await writeTaskDocuments({ paths: options.paths, record: finished });
      await archiveTask({
        paths: options.paths,
        record: finished,
        taskMarkdown: markdown,
        archiveReason: disposition,
      });
      return { outputText: JSON.stringify(compactTask(finished)) };
    },
  };
}

export function registerTaskTools(registry: ToolRegistry, options: TaskToolOptions): void {
  registry.register(buildReadTopTool(options));
  registry.register(buildInsertTool(options));
  registry.register(buildUpdateTool(options));
  registry.register(buildReorderTool(options));
  registry.register(buildListTool(options));
  registry.register(buildCompleteTool(options));
  registry.register(buildStaleTool(options));
}
