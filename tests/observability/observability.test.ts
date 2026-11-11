import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventJournal } from "../../src/observability/event-journal.js";
import { LiteMetrics } from "../../src/observability/metrics.js";
import { buildDiagnosticBundle, writeDiagnosticBundle } from "../../src/observability/diagnostic-bundle.js";
import { redactText, redactValue } from "../../src/observability/redaction.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

describe("redaction", () => {
  it("removes tokens and absolute paths", () => {
    const token = ["gh", "p_"].join("") + "a".repeat(30);
    const windowsPath = ["C:", "Users", "alice", "file.txt"].join("\\");
    const redacted = redactText(`${token} ${windowsPath} /home/alice/secret`);
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain(windowsPath);
    expect(redacted).not.toContain("/home/alice");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("[PATH]");
  });

  it("redacts sensitive object keys", () => {
    expect(redactValue({ apiToken: "value", nested: { path: ["C:", "tmp"].join("\\") } })).toEqual({
      apiToken: "[REDACTED]",
      nested: { path: "[PATH]" },
    });
  });
});

describe("metrics", () => {
  it("aggregates counters, gauges and histograms", () => {
    const metrics = new LiteMetrics();
    metrics.increment("turns");
    metrics.increment("turns", 2);
    metrics.setGauge("queue", 3);
    metrics.observe("latency", 10);
    metrics.observe("latency", 20);
    expect(metrics.snapshot()).toEqual({
      counters: { turns: 3 },
      gauges: { queue: 3 },
      histograms: {
        latency: { count: 2, sum: 30, minimum: 10, maximum: 20, average: 15 },
      },
    });
  });
});

describe("diagnostic bundle and event journal", () => {
  it("writes redacted events and a redacted bundle", async () => {
    const workspace = await createTestDirectory("observability");
    directories.push(workspace);
    const token = ["gh", "p_"].join("") + "a".repeat(30);
    const windowsPath = ["C:", "Users", "alice", "file.txt"].join("\\");

    const journal = new EventJournal(path.join(workspace, "events.jsonl"));
    await journal.append({ type: "error", message: `failed ${token} ${windowsPath}` });
    const events = await journal.readAll<{ message: string }>();
    expect(events[0]?.message).not.toContain(token);
    expect(events[0]?.message).not.toContain(windowsPath);

    const metrics = new LiteMetrics();
    metrics.increment("turns");
    const bundle = buildDiagnosticBundle({
      packageVersion: "0.0.0",
      kernelStatus: "idle",
      metrics: metrics.snapshot(),
      recentEvents: events,
    });
    expect(JSON.stringify(bundle)).not.toContain(token);
    expect(JSON.stringify(bundle)).not.toContain(windowsPath);
    const bundlePath = path.join(workspace, "diagnostics.json");
    await writeDiagnosticBundle(bundlePath, bundle);
    expect(JSON.parse(await fs.readFile(bundlePath, "utf8"))).toMatchObject({
      packageName: "astarray-lite",
      kernelStatus: "idle",
    });
  });
});
