export const LITE_CAPABILITY_IDS = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "process.shell",
  "network.read",
  "monitor.create",
  "monitor.control",
  "task.manage",
  "tool.install",
  "tool.delete",
] as const;

export type LiteCapabilityId = (typeof LITE_CAPABILITY_IDS)[number];

export type LitePermissionProfile = "safe" | "balanced" | "trusted";

export type LitePermissionDecision = "allow" | "ask" | "deny";

export const USER_ONLY_CAPABILITIES: ReadonlySet<LiteCapabilityId> = new Set([
  "tool.install",
  "tool.delete",
]);

type ProfileMatrix = Readonly<Record<LiteCapabilityId, LitePermissionDecision>>;

export const LITE_PROFILE_MATRIX: Readonly<Record<LitePermissionProfile, ProfileMatrix>> = {
  safe: {
    "fs.read": "allow",
    "fs.write": "deny",
    "fs.delete": "deny",
    "process.shell": "deny",
    "network.read": "deny",
    "monitor.create": "deny",
    "monitor.control": "deny",
    "task.manage": "allow",
    "tool.install": "deny",
    "tool.delete": "deny",
  },
  balanced: {
    "fs.read": "allow",
    "fs.write": "ask",
    "fs.delete": "deny",
    "process.shell": "ask",
    "network.read": "ask",
    "monitor.create": "ask",
    "monitor.control": "allow",
    "task.manage": "allow",
    "tool.install": "deny",
    "tool.delete": "deny",
  },
  trusted: {
    "fs.read": "allow",
    "fs.write": "allow",
    "fs.delete": "allow",
    "process.shell": "allow",
    "network.read": "allow",
    "monitor.create": "allow",
    "monitor.control": "allow",
    "task.manage": "allow",
    "tool.install": "deny",
    "tool.delete": "deny",
  },
};

export const DEFAULT_TOOL_CAPABILITY: Readonly<Record<string, LiteCapabilityId>> = {
  read_file: "fs.read",
  list_directory: "fs.read",
  write_file: "fs.write",
  replace_in_file: "fs.write",
  shell: "process.shell",
  monitor_create: "monitor.create",
  monitor_set_enabled: "monitor.control",
  monitor_list: "fs.read",
  monitor_read: "fs.read",
  task_read_top: "task.manage",
  task_insert: "task.manage",
  task_update: "task.manage",
  task_reorder: "task.manage",
  task_list: "task.manage",
  task_complete: "task.manage",
  mark_task_stale: "task.manage",
  reply_user: "task.manage",
  mark_user_message: "task.manage",
};

export function isLiteCapabilityId(value: string): value is LiteCapabilityId {
  return (LITE_CAPABILITY_IDS as readonly string[]).includes(value);
}
