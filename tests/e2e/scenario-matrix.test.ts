import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

interface ScenarioEvidence {
  readonly id: number;
  readonly name: string;
  readonly evidence: readonly string[];
}

/**
 * §15.2 scenario matrix. Each scenario points at the automated evidence that
 * currently covers it; unsupported UI-only scenarios stay in the private UI
 * repository and are not asserted here.
 */
const SCENARIOS: readonly ScenarioEvidence[] = [
  { id: 1, name: "idle 60s without provider calls", evidence: ["tests/kernel/turn-arbiter.test.ts"] },
  { id: 2, name: "user message answered", evidence: ["tests/messages/user-turn.test.ts"] },
  { id: 3, name: "user message converted to task", evidence: ["tests/tools/task-tools.test.ts"] },
  { id: 4, name: "user message classified as noise", evidence: ["tests/messages/user-turn.test.ts"] },
  { id: 5, name: "task preempted during tool batch", evidence: ["tests/kernel/preemption.test.ts"] },
  { id: 6, name: "needs-review creates review task", evidence: ["tests/tasks/completion-verifier.test.ts"] },
  { id: 7, name: "three messages FIFO", evidence: ["tests/messages/user-turn.test.ts"] },
  { id: 8, name: "stable context prefix hash", evidence: ["tests/context/context-assembler.test.ts"] },
  { id: 9, name: "monitor sampling and projection", evidence: ["tests/monitors/monitor-executors.test.ts", "tests/monitors/monitor-scheduler.test.ts"] },
  { id: 10, name: "permission ask allow/deny", evidence: ["tests/permissions/permission-manager.test.ts"] },
  { id: 11, name: "pre-image backup before overwrite", evidence: ["tests/tools/file-tools.test.ts"] },
  { id: 12, name: "twelve crash injection points", evidence: ["tests/testing/fault-injection.test.ts"] },
  { id: 13, name: "non-idempotent unknown outcome", evidence: ["tests/kernel/preemption.test.ts", "tests/testing/fault-recovery.test.ts"] },
  { id: 14, name: "tool package install/enable/disable/delete", evidence: ["tests/tools/tool-package-lifecycle.test.ts"] },
  { id: 15, name: "context budget trimming", evidence: ["tests/context/token-budget.test.ts"] },
  { id: 16, name: "sensitive file and secret redaction", evidence: ["tests/tools/path-safety.test.ts", "tests/observability/observability.test.ts"] },
  { id: 17, name: "GUI facade compatibility", evidence: ["tests/compatibility/gui-port-compat.test.ts"] },
  { id: 18, name: "second kernel locked out", evidence: ["tests/persistence/lock.test.ts"] },
  { id: 19, name: "provider 429 retry and 401 fail-closed", evidence: ["tests/runtime/retry-policy.test.ts"] },
  { id: 20, name: "usage budget exhaustion", evidence: ["tests/runtime/usage-budget.test.ts"] },
  { id: 21, name: "goal review and no-progress blocking", evidence: ["tests/tasks/goal-scheduler.test.ts"] },
];

describe("E2E scenario matrix", () => {
  it("covers every scenario with existing automated evidence", () => {
    expect(SCENARIOS).toHaveLength(21);
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(21);
    for (const scenario of SCENARIOS) {
      expect(scenario.evidence.length).toBeGreaterThan(0);
      for (const evidence of scenario.evidence) {
        expect(existsSync(path.join(repositoryRoot, evidence)), `${scenario.id}: ${evidence}`).toBe(true);
      }
    }
  });
});
