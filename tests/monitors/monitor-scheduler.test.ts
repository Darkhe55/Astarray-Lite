import { describe, expect, it } from "vitest";

import { createMonitorSpec } from "../../src/monitors/monitor-registry.js";
import { MonitorScheduler } from "../../src/monitors/monitor-scheduler.js";
import { projectMonitors } from "../../src/monitors/monitor-projection.js";

const now = "2026-01-01T00:00:00.000Z";

function monitor(index: number, overrides: { readonly isEnabled?: boolean } = {}) {
  return createMonitorSpec({
    name: `m-${index}`,
    kind: "system",
    config: { kind: "system", metric: "queue-depth" },
    isEnabled: overrides.isEnabled ?? true,
    intervalSeconds: 60,
    nowIso: now,
    monitorId: `mon_${index}`,
  });
}

describe("MonitorScheduler", () => {
  it("schedules due monitors with a concurrency cap", () => {
    const scheduler = new MonitorScheduler({ maxConcurrent: 2, now: () => new Date(now) });
    const definitions = [monitor(1), monitor(2), monitor(3)];
    scheduler.sync(definitions);
    const due = scheduler.getDueMonitors(definitions, now);
    expect(due).toHaveLength(2);
    expect(scheduler.beginSample("mon_1")).toBe(true);
    expect(scheduler.beginSample("mon_1")).toBe(false);
    expect(scheduler.beginSample("mon_2")).toBe(true);
    expect(scheduler.beginSample("mon_3")).toBe(false);
  });

  it("backs off on failure and resets on success", () => {
    const scheduler = new MonitorScheduler({ now: () => new Date(now) });
    const definitions = [monitor(1)];
    scheduler.sync(definitions);

    const first = scheduler.completeSample("mon_1", { ok: false, intervalSeconds: 60, atIso: now });
    expect(first.consecutiveFailures).toBe(1);
    expect(Date.parse(first.nextDueAtIso)).toBe(Date.parse(now) + 120_000);

    const second = scheduler.completeSample("mon_1", { ok: false, intervalSeconds: 60, atIso: now });
    expect(second.consecutiveFailures).toBe(2);
    expect(Date.parse(second.nextDueAtIso)).toBe(Date.parse(now) + 240_000);

    const success = scheduler.completeSample("mon_1", { ok: true, intervalSeconds: 60, atIso: now });
    expect(success.consecutiveFailures).toBe(0);
    expect(Date.parse(success.nextDueAtIso)).toBe(Date.parse(now) + 60_000);
  });

  it("does not schedule disabled monitors", () => {
    const scheduler = new MonitorScheduler({ now: () => new Date(now) });
    const definitions = [monitor(1, { isEnabled: false })];
    scheduler.sync(definitions);
    expect(scheduler.getDueMonitors(definitions, now)).toHaveLength(0);
  });

  it("deduplicates identical alerts for five minutes", () => {
    const scheduler = new MonitorScheduler({ now: () => new Date(now) });
    expect(scheduler.markAlert("mon_1", "disk:>80", now)).toBe(true);
    expect(scheduler.markAlert("mon_1", "disk:>80", now)).toBe(false);
    expect(scheduler.markAlert("mon_1", "disk:>90", now)).toBe(true);
    const later = new Date(Date.parse(now) + 6 * 60_000).toISOString();
    expect(scheduler.markAlert("mon_1", "disk:>80", later)).toBe(true);
  });
});

describe("projectMonitors", () => {
  it("projects enabled monitors only, capped at twelve lines", () => {
    const entries = Array.from({ length: 14 }, (_, index) => ({
      spec: monitor(index, { isEnabled: index !== 0 }),
      sample: { ok: true, value: `v${index}`, sampledAtIso: now },
    }));
    const text = projectMonitors(entries);
    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(13);
    expect(text).toContain("[truncated: more monitors]");
    expect(text).not.toContain("m-0:");
  });

  it("marks failed samples as alerts and caps characters", () => {
    const text = projectMonitors(
      [
        {
          spec: monitor(1),
          sample: { ok: false, value: "x".repeat(500), sampledAtIso: now },
        },
      ],
      { maximumCharacters: 100 },
    );
    expect(text).toContain("[ALERT]");
    expect(text.length).toBeLessThanOrEqual(100);
  });
});
