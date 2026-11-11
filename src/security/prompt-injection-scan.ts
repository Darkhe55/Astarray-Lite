import { LiteJournal } from "../persistence/journal.js";

export interface PromptInjectionScanResult {
  readonly suspect: boolean;
  readonly matches: readonly string[];
}

const INJECTION_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "ignore-previous", pattern: /ignore (?:all )?(?:previous|prior) instructions?/iu },
  { label: "disregard-system", pattern: /disregard (?:the )?(?:system|previous) (?:prompt|instructions?)/iu },
  { label: "you-are-now", pattern: /you are now (?:a|an|the)\b/iu },
  { label: "system-prompt", pattern: /(?:reveal|print|show).{0,20}(?:system prompt|hidden instructions?)/iu },
  { label: "do-not-tell", pattern: /do not (?:tell|inform) the user/iu },
  { label: "chinese-ignore", pattern: /(?:忽略|无视|忘记).{0,12}(?:以上|之前|前面|系统).{0,8}(?:指令|提示|规则)/u },
  { label: "chinese-ignore-short", pattern: /(?:忽略|无视).{0,8}(?:指令|提示|规则)/u },
  { label: "chinese-override", pattern: /(?:覆盖|绕过).{0,8}(?:系统|安全|权限).{0,8}(?:指令|规则|限制)/u },
];

/**
 * Flags likely instruction-injection text. Results are advisory: tool output
 * keeps its original meaning and is still wrapped as untrusted data.
 */
export function scanForPromptInjection(text: string): PromptInjectionScanResult {
  const matches = INJECTION_PATTERNS.filter((entry) => entry.pattern.test(text)).map(
    (entry) => entry.label,
  );
  return { suspect: matches.length > 0, matches };
}

export interface SecurityJournalEvent {
  readonly schemaVersion: 1;
  readonly kind: "prompt-injection-suspect";
  readonly atIso: string;
  readonly source: string;
  readonly matches: readonly string[];
  readonly excerpt: string;
}

export async function appendSecurityEvent(
  journalFile: string,
  event: SecurityJournalEvent,
): Promise<void> {
  await new LiteJournal(journalFile).append(event);
}

export async function scanSecurityJournal(
  journalFile: string,
): Promise<readonly SecurityJournalEvent[]> {
  return new LiteJournal(journalFile).readAll<SecurityJournalEvent>();
}
