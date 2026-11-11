import { LiteError } from "../contracts/errors.js";
import { createLiteIdentifier } from "../contracts/identifiers.js";
import type { LitePaths } from "../persistence/lite-paths.js";
import { readJsonWithBackup, writeJsonAtomic } from "../persistence/state-store.js";

export type LiteMonitorKind = "command" | "file" | "http" | "process" | "system";

export type LiteMonitorConfig =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly workingDirectory: string;
      readonly environmentVariableNames: readonly string[];
    }
  | {
      readonly kind: "file";
      readonly relativePath: string;
      readonly watch: "mtime" | "size" | "content-hash" | "regex";
      readonly pattern?: string;
    }
  | {
      readonly kind: "http";
      readonly url: string;
      readonly method: "GET" | "HEAD";
      readonly expectedStatus?: number;
    }
  | {
      readonly kind: "process";
      readonly pid?: number;
      readonly port?: number;
      readonly host?: string;
    }
  | {
      readonly kind: "system";
      readonly metric: "queue-depth" | "token-usage" | "active-task-age";
    };

export interface LiteMonitorAlert {
  readonly kind: "regex" | "contains" | "threshold" | "exit-code";
  readonly pattern?: string;
  readonly threshold?: number;
  readonly comparison?: "gt" | "lt" | "eq";
}

export interface LiteMonitorSpec {
  readonly schemaVersion: 1;
  readonly monitorId: string;
  readonly revision: number;
  readonly name: string;
  readonly kind: LiteMonitorKind;
  readonly isEnabled: boolean;
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly config: LiteMonitorConfig;
  readonly projection: {
    readonly label: string;
    readonly maximumCharacters: number;
  };
  readonly alert?: LiteMonitorAlert;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  readonly permissionGrantId?: string;
}

interface MonitorDefinitionsFile {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAtIso: string;
  readonly monitors: readonly LiteMonitorSpec[];
}

export interface CreateMonitorInput {
  readonly name: string;
  readonly kind: LiteMonitorKind;
  readonly config: LiteMonitorConfig;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
  readonly isEnabled?: boolean;
  readonly projection?: { readonly label: string; readonly maximumCharacters: number };
  readonly alert?: LiteMonitorAlert;
  readonly nowIso?: string;
  readonly monitorId?: string;
}

export const MAXIMUM_MONITOR_DEFINITIONS = 24;
export const MAXIMUM_ENABLED_MONITORS = 12;
const MINIMUM_INTERVAL_SECONDS = 3;
const MAXIMUM_INTERVAL_SECONDS = 3_600;
const MINIMUM_TIMEOUT_SECONDS = 1;
const MAXIMUM_TIMEOUT_SECONDS = 300;

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} must be non-empty`);
  }
}

function validateConfig(config: LiteMonitorConfig): void {
  switch (config.kind) {
    case "command":
      assertNonEmpty(config.command, "config.command");
      assertNonEmpty(config.workingDirectory, "config.workingDirectory");
      if (!Array.isArray(config.environmentVariableNames)) {
        throw new LiteError("LITE_INVALID_ARGUMENT", "config.environmentVariableNames must be an array");
      }
      return;
    case "file":
      assertNonEmpty(config.relativePath, "config.relativePath");
      if (
        !["mtime", "size", "content-hash", "regex"].includes(config.watch)
      ) {
        throw new LiteError("LITE_INVALID_ARGUMENT", "config.watch is invalid");
      }
      if (config.watch === "regex") {
        assertNonEmpty(config.pattern ?? "", "config.pattern");
        try {
          new RegExp(config.pattern ?? "", "u");
        } catch {
          throw new LiteError("LITE_INVALID_ARGUMENT", "config.pattern is invalid");
        }
      }
      return;
    case "http": {
      let url: URL;
      try {
        url = new URL(config.url);
      } catch {
        throw new LiteError("LITE_INVALID_ARGUMENT", "config.url is invalid");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new LiteError("LITE_INVALID_ARGUMENT", "config.url must use http or https");
      }
      if (config.method !== "GET" && config.method !== "HEAD") {
        throw new LiteError("LITE_INVALID_ARGUMENT", "config.method is invalid");
      }
      if (config.expectedStatus !== undefined && (!Number.isInteger(config.expectedStatus) || config.expectedStatus < 100 || config.expectedStatus > 599)) {
        throw new LiteError("LITE_INVALID_ARGUMENT", "config.expectedStatus is invalid");
      }
      return;
    }
    case "process":
      if (
        (config.pid === undefined || !Number.isInteger(config.pid) || config.pid < 1) &&
        (config.port === undefined || !Number.isInteger(config.port) || config.port < 1 || config.port > 65_535)
      ) {
        throw new LiteError("LITE_INVALID_ARGUMENT", "process monitor requires a valid pid or port");
      }
      if (config.host !== undefined) assertNonEmpty(config.host, "config.host");
      return;
    case "system":
      if (!["queue-depth", "token-usage", "active-task-age"].includes(config.metric)) {
        throw new LiteError("LITE_INVALID_ARGUMENT", "config.metric is invalid");
      }
      return;
  }
}

function validateAlert(alert: LiteMonitorAlert | undefined): void {
  if (alert === undefined) return;
  if (alert.kind === "regex" || alert.kind === "contains") {
    assertNonEmpty(alert.pattern ?? "", "alert.pattern");
    if (alert.kind === "regex") {
      try {
        new RegExp(alert.pattern ?? "", "u");
      } catch {
        throw new LiteError("LITE_INVALID_ARGUMENT", "alert.pattern is invalid");
      }
    }
  }
  if (alert.kind === "threshold") {
    if (alert.threshold === undefined || !Number.isFinite(alert.threshold)) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "threshold alert requires threshold");
    }
    if (alert.comparison === undefined) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "threshold alert requires comparison");
    }
  }
}

export function validateMonitorSpec(spec: LiteMonitorSpec): void {
  if (spec.schemaVersion !== 1) {
    throw new LiteError("LITE_SCHEMA_UNSUPPORTED", "unsupported monitor schema version");
  }
  assertNonEmpty(spec.monitorId, "monitorId");
  assertNonEmpty(spec.name, "name");
  if (!Number.isInteger(spec.intervalSeconds) || spec.intervalSeconds < MINIMUM_INTERVAL_SECONDS || spec.intervalSeconds > MAXIMUM_INTERVAL_SECONDS) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "intervalSeconds is out of range");
  }
  if (!Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds < MINIMUM_TIMEOUT_SECONDS || spec.timeoutSeconds > MAXIMUM_TIMEOUT_SECONDS) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "timeoutSeconds is out of range");
  }
  if (spec.kind !== spec.config.kind) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "monitor kind does not match config kind");
  }
  validateConfig(spec.config);
  assertNonEmpty(spec.projection.label, "projection.label");
  if (!Number.isInteger(spec.projection.maximumCharacters) || spec.projection.maximumCharacters < 1 || spec.projection.maximumCharacters > 2_000) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "projection.maximumCharacters is out of range");
  }
  validateAlert(spec.alert);
}

export function createMonitorSpec(input: CreateMonitorInput): LiteMonitorSpec {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const spec: LiteMonitorSpec = {
    schemaVersion: 1,
    monitorId: input.monitorId ?? createLiteIdentifier("mon"),
    revision: 1,
    name: input.name,
    kind: input.kind,
    isEnabled: input.isEnabled ?? false,
    intervalSeconds: input.intervalSeconds ?? 60,
    timeoutSeconds: input.timeoutSeconds ?? 10,
    config: input.config,
    projection: input.projection ?? { label: input.name, maximumCharacters: 200 },
    ...(input.alert === undefined ? {} : { alert: input.alert }),
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };
  validateMonitorSpec(spec);
  return spec;
}

/**
 * Durable monitor definitions. Mutations enforce the 24-definition and
 * 12-enabled limits and write atomically; the file revision advances on every
 * accepted mutation.
 */
export class MonitorRegistry {
  private readonly paths: LitePaths;
  private readonly now: () => Date;
  private definitions: MonitorDefinitionsFile = {
    schemaVersion: 1,
    revision: 1,
    updatedAtIso: new Date(0).toISOString(),
    monitors: [],
  };

  constructor(options: { readonly paths: LitePaths; readonly now?: () => Date }) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    const result = await readJsonWithBackup<MonitorDefinitionsFile>(
      this.paths.monitorDefinitionsFile,
      `${this.paths.monitorDefinitionsFile}.bak`,
    );
    if (result === null) return;
    if (result.value.schemaVersion !== 1 || !Array.isArray(result.value.monitors)) {
      throw new LiteError("LITE_STATE_CORRUPT", "monitor definitions are corrupt");
    }
    if (result.value.monitors.length > MAXIMUM_MONITOR_DEFINITIONS) {
      throw new LiteError("LITE_MONITOR_LIMIT_EXCEEDED", "too many monitor definitions");
    }
    if (result.value.monitors.filter((monitor) => monitor.isEnabled).length > MAXIMUM_ENABLED_MONITORS) {
      throw new LiteError("LITE_MONITOR_LIMIT_EXCEEDED", "too many enabled monitors");
    }
    for (const monitor of result.value.monitors) validateMonitorSpec(monitor);
    this.definitions = result.value;
  }

  list(): readonly LiteMonitorSpec[] {
    return [...this.definitions.monitors].sort((left, right) => left.name.localeCompare(right.name));
  }

  get(monitorId: string): LiteMonitorSpec | undefined {
    return this.definitions.monitors.find((monitor) => monitor.monitorId === monitorId);
  }

  getRevision(): number {
    return this.definitions.revision;
  }

  async create(input: CreateMonitorInput): Promise<LiteMonitorSpec> {
    if (this.definitions.monitors.length >= MAXIMUM_MONITOR_DEFINITIONS) {
      throw new LiteError("LITE_MONITOR_LIMIT_EXCEEDED", "maximum monitor definitions reached");
    }
    if (this.definitions.monitors.some((monitor) => monitor.name === input.name)) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "monitor name must be unique");
    }
    const spec = createMonitorSpec({ ...input, nowIso: input.nowIso ?? this.now().toISOString() });
    if (spec.isEnabled && this.getEnabledCount() >= MAXIMUM_ENABLED_MONITORS) {
      throw new LiteError("LITE_MONITOR_LIMIT_EXCEEDED", "maximum enabled monitors reached");
    }
    this.definitions = await this.commit([...this.definitions.monitors, spec]);
    return spec;
  }

  async setEnabled(monitorId: string, isEnabled: boolean): Promise<LiteMonitorSpec> {
    const monitor = this.require(monitorId);
    if (isEnabled && !monitor.isEnabled && this.getEnabledCount() >= MAXIMUM_ENABLED_MONITORS) {
      throw new LiteError("LITE_MONITOR_LIMIT_EXCEEDED", "maximum enabled monitors reached");
    }
    const updated: LiteMonitorSpec = {
      ...monitor,
      isEnabled,
      revision: monitor.revision + 1,
      updatedAtIso: this.now().toISOString(),
    };
    await this.commit(this.definitions.monitors.map((entry) => (entry.monitorId === monitorId ? updated : entry)));
    return updated;
  }

  async update(
    monitorId: string,
    patch: {
      readonly name?: string;
      readonly intervalSeconds?: number;
      readonly timeoutSeconds?: number;
      readonly projection?: { readonly label: string; readonly maximumCharacters: number };
      readonly alert?: LiteMonitorAlert;
      readonly expectedRevision?: number;
    },
  ): Promise<LiteMonitorSpec> {
    const monitor = this.require(monitorId);
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== monitor.revision) {
      throw new LiteError("LITE_TASK_REVISION_CONFLICT", "monitor revision conflict", {
        latestRevision: monitor.revision,
      });
    }
    if (
      patch.name !== undefined &&
      this.definitions.monitors.some((entry) => entry.name === patch.name && entry.monitorId !== monitorId)
    ) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "monitor name must be unique");
    }
    const updated: LiteMonitorSpec = {
      ...monitor,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.intervalSeconds === undefined ? {} : { intervalSeconds: patch.intervalSeconds }),
      ...(patch.timeoutSeconds === undefined ? {} : { timeoutSeconds: patch.timeoutSeconds }),
      ...(patch.projection === undefined ? {} : { projection: patch.projection }),
      ...(patch.alert === undefined ? {} : { alert: patch.alert }),
      revision: monitor.revision + 1,
      updatedAtIso: this.now().toISOString(),
    };
    validateMonitorSpec(updated);
    await this.commit(this.definitions.monitors.map((entry) => (entry.monitorId === monitorId ? updated : entry)));
    return updated;
  }

  async remove(monitorId: string): Promise<void> {
    this.require(monitorId);
    await this.commit(this.definitions.monitors.filter((monitor) => monitor.monitorId !== monitorId));
  }

  private getEnabledCount(): number {
    return this.definitions.monitors.filter((monitor) => monitor.isEnabled).length;
  }

  private require(monitorId: string): LiteMonitorSpec {
    const monitor = this.get(monitorId);
    if (monitor === undefined) {
      throw new LiteError("LITE_MONITOR_NOT_FOUND", `monitor not found: ${monitorId}`);
    }
    return monitor;
  }

  private async commit(monitors: readonly LiteMonitorSpec[]): Promise<MonitorDefinitionsFile> {
    const next: MonitorDefinitionsFile = {
      schemaVersion: 1,
      revision: this.definitions.revision + 1,
      updatedAtIso: this.now().toISOString(),
      monitors,
    };
    await writeJsonAtomic(
      this.paths.monitorDefinitionsFile,
      `${this.paths.monitorDefinitionsFile}.bak`,
      next,
    );
    this.definitions = next;
    return next;
  }
}
