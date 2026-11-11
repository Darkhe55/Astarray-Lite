import type { LiteMonitorSpec } from "./monitor-registry.js";

export interface MonitorProjectionSample {
  readonly ok: boolean;
  readonly value: string;
  readonly sampledAtIso: string;
}

export interface MonitorProjectionEntry {
  readonly spec: LiteMonitorSpec;
  readonly sample?: MonitorProjectionSample;
}

export interface MonitorProjectionOptions {
  readonly maximumLines?: number;
  readonly maximumCharacters?: number;
}

/**
 * One-line-per-enabled-monitor projection for the volatile context block.
 * Lines are sorted by label, capped at 12, and the total text is bounded.
 */
export function projectMonitors(
  entries: readonly MonitorProjectionEntry[],
  options: MonitorProjectionOptions = {},
): string {
  const maximumLines = options.maximumLines ?? 12;
  const maximumCharacters = options.maximumCharacters ?? 1_000;
  const lines = entries
    .filter((entry) => entry.spec.isEnabled)
    .sort((left, right) => left.spec.projection.label.localeCompare(right.spec.projection.label))
    .map((entry) => {
      const sample = entry.sample;
      if (sample === undefined) {
        return `${entry.spec.projection.label}: unavailable`;
      }
      const line = `${entry.spec.projection.label}: ${sample.value}`;
      return sample.ok ? line : `[ALERT] ${line}`;
    });

  const selected = lines.slice(0, maximumLines);
  let text = selected.join("\n");
  if (lines.length > maximumLines) {
    text += "\n[truncated: more monitors]";
  }
  if (text.length > maximumCharacters) {
    const marker = "\n[truncated]";
    text = `${text.slice(0, Math.max(0, maximumCharacters - marker.length))}${marker}`;
  }
  return text;
}
