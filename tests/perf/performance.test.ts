import { promises as fs } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { assembleContext } from "../../src/context/context-assembler.js";
import { LiteJournal } from "../../src/persistence/journal.js";
import { resolveLitePaths } from "../../src/persistence/lite-paths.js";
import { createMonitorSpec } from "../../src/monitors/monitor-registry.js";
import { MonitorScheduler } from "../../src/monitors/monitor-scheduler.js";
import { createTaskRecord } from "../../src/tasks/task-record.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterAll(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}

function elapsed(action: () => unknown): number {
  const start = performance.now();
  action();
  return performance.now() - start;
}

describe("performance targets", () => {
  it("context assembly p95 stays below 50ms", () => {
    const timings: number[] = [];
    for (let index = 0; index < 80; index += 1) {
      timings.push(
        elapsed(() =>
          assembleContext({
            promptVersion: "lite-1.0",
            promptText: "system prompt",
            toolsetRevision: 3,
            tools: Array.from({ length: 18 }, (_, toolIndex) => ({
              name: `tool_${toolIndex}`,
              summary: `tool ${toolIndex}`,
              inputSchema: { type: "object", properties: { path: { type: "string" } } },
            })),
            task: {
              taskId: "tsk_01JABCDEFG",
              revision: 7,
              taskKind: "normal",
              documentText: "x".repeat(4_000),
            },
            transcript: Array.from({ length: 20 }, (_, turnIndex) => ({
              turnId: `trn_${turnIndex}`,
              role: "assistant" as const,
              summary: "ok",
            })),
            user: { messageId: "msg_01JABCDEFG", text: "hello", attachments: [] },
          }),
        ),
      );
    }
    expect(percentile(timings, 0.95)).toBeLessThan(50);
  });

  it("task_list over 1000 pending tasks stays below 30ms", async () => {
    const store = new TaskStore({ now: () => new Date(now) });
    for (let index = 0; index < 1_000; index += 1) {
      await store.insertTask({
        title: `task ${index}`,
        objective: `objective ${index}`,
        nowIso: now,
        taskId: `tsk_${index}`,
      });
    }
    const timings: number[] = [];
    for (let index = 0; index < 40; index += 1) timings.push(elapsed(() => store.list()));
    expect(store.list()).toHaveLength(1_000);
    expect(percentile(timings, 0.95)).toBeLessThan(30);
  });

  it("journal replay of 10,000 events stays below 2s", async () => {
    const workspace = await createTestDirectory("perf-journal");
    directories.push(workspace);
    const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
    const journalPath = path.join(paths.stateRoot, "events.jsonl");
    const journal = new LiteJournal(journalPath);
    const lines = Array.from({ length: 10_000 }, (_, index) =>
      JSON.stringify({ type: "event", index, atIso: now }),
    ).join("\n");
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    await fs.writeFile(journalPath, `${lines}\n`, "utf8");
    const timings = [elapsed(() => journal.readAll())];
    expect(timings[0]).toBeLessThan(2_000);
  });

  it("ten monitors remain capped at two concurrent samples", () => {
    const scheduler = new MonitorScheduler({ maxConcurrent: 2, now: () => new Date(now) });
    const monitors = Array.from({ length: 10 }, (_, index) =>
      createMonitorSpec({
        name: `m-${index}`,
        kind: "system",
        config: { kind: "system", metric: "queue-depth" },
        isEnabled: true,
        intervalSeconds: 60,
        nowIso: now,
        monitorId: `mon_${index}`,
      }),
    );
    scheduler.sync(monitors);
    const timings: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      timings.push(
        elapsed(() => {
          const due = scheduler.getDueMonitors(monitors, now);
          for (const monitor of due) scheduler.beginSample(monitor.monitorId);
        }),
      );
      for (const monitor of monitors) scheduler.completeSample(monitor.monitorId, { ok: true, intervalSeconds: 60, atIso: now });
    }
    expect(scheduler.getInFlightCount()).toBeLessThanOrEqual(2);
    expect(percentile(timings, 0.95)).toBeLessThan(20);
  });
});
