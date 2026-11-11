/**
 * Public capability descriptor for Astarray Lite.
 *
 * The descriptor is deliberately data-only: the UI can render it without
 * importing kernel internals, and unsupported core features are reported
 * honestly instead of being faked.
 */

export const LITE_CONTRACT_VERSION = 1 as const;

export interface LiteCapabilitySupports {
  readonly userMessages: boolean;
  readonly tasks: boolean;
  readonly goalTasks: boolean;
  readonly monitors: boolean;
  readonly toolPackages: boolean;
  readonly permissions: boolean;
  readonly history: boolean;
  readonly multiAgent: boolean;
  readonly crossProject: boolean;
  readonly explicitGoalMode: boolean;
  readonly craftsman: boolean;
  readonly workWindow: boolean;
}

export interface LiteCapabilityDescriptor {
  readonly kernel: "lite";
  readonly schemaVersion: typeof LITE_CONTRACT_VERSION;
  readonly packageName: "astarray-lite";
  readonly supports: LiteCapabilitySupports;
  readonly limitations: readonly string[];
}

export const LITE_CAPABILITIES = {
  kernel: "lite",
  schemaVersion: LITE_CONTRACT_VERSION,
  packageName: "astarray-lite",
  supports: {
    userMessages: true,
    tasks: true,
    goalTasks: true,
    monitors: true,
    toolPackages: true,
    permissions: true,
    history: true,
    multiAgent: false,
    crossProject: false,
    explicitGoalMode: false,
    craftsman: false,
    workWindow: false,
  },
  limitations: [
    "single agent per kernel",
    "single active task and single active user message",
    "no cross-agent delegation",
    "no DAG scheduler or task bundles",
    "no cross-project borrowing in v1",
    "no explicit Goal Mode control plane; goals are task attributes",
  ],
} as const satisfies LiteCapabilityDescriptor;

export function describeLiteCapabilities(): LiteCapabilityDescriptor {
  return {
    kernel: LITE_CAPABILITIES.kernel,
    schemaVersion: LITE_CAPABILITIES.schemaVersion,
    packageName: LITE_CAPABILITIES.packageName,
    supports: { ...LITE_CAPABILITIES.supports },
    limitations: [...LITE_CAPABILITIES.limitations],
  };
}
