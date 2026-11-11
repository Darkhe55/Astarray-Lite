import { writeJsonAtomic } from "../persistence/state-store.js";
import type { LiteMetricsSnapshot } from "./metrics.js";
import { redactValue } from "./redaction.js";

export interface DiagnosticBundle {
  readonly schemaVersion: 1;
  readonly generatedAtIso: string;
  readonly packageName: "astarray-lite";
  readonly packageVersion: string;
  readonly kernelStatus: string;
  readonly sessionId: string | null;
  readonly projectIdentifier: string | null;
  readonly metrics: LiteMetricsSnapshot;
  readonly recentEvents: readonly unknown[];
  readonly environment: {
    readonly platform: string;
    readonly nodeVersion: string;
  };
}

export function buildDiagnosticBundle(input: {
  readonly generatedAtIso?: string;
  readonly packageVersion: string;
  readonly kernelStatus: string;
  readonly sessionId?: string;
  readonly projectIdentifier?: string;
  readonly metrics: LiteMetricsSnapshot;
  readonly recentEvents?: readonly unknown[];
}): DiagnosticBundle {
  const bundle: DiagnosticBundle = {
    schemaVersion: 1,
    generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
    packageName: "astarray-lite",
    packageVersion: input.packageVersion,
    kernelStatus: input.kernelStatus,
    sessionId: input.sessionId ?? null,
    projectIdentifier: input.projectIdentifier ?? null,
    metrics: input.metrics,
    recentEvents: (input.recentEvents ?? []).slice(-50),
    environment: {
      platform: process.platform,
      nodeVersion: process.version,
    },
  };
  return redactValue(bundle) as unknown as DiagnosticBundle;
}

export async function writeDiagnosticBundle(
  filePath: string,
  bundle: DiagnosticBundle,
): Promise<void> {
  await writeJsonAtomic(filePath, `${filePath}.bak`, bundle);
}
