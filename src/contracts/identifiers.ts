import { randomBytes } from "node:crypto";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const TOTAL_LENGTH = TIME_LENGTH + RANDOM_LENGTH;

export type LiteIdentifierPrefix = "msg" | "tsk" | "mon" | "trn" | "pkg" | "ask";

function encodeTime(milliseconds: number): string {
  let remaining = Math.floor(milliseconds);
  const characters: string[] = new Array<string>(TIME_LENGTH);
  for (let index = TIME_LENGTH - 1; index >= 0; index -= 1) {
    characters[index] = CROCKFORD_ALPHABET[remaining % 32] ?? "0";
    remaining = Math.floor(remaining / 32);
  }
  return characters.join("");
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LENGTH);
  let result = "";
  for (const byte of bytes) {
    result += CROCKFORD_ALPHABET[byte % 32] ?? "0";
  }
  return result;
}

/**
 * Generates a ULID-shaped identifier: 10 time characters + 16 random
 * characters, using Crockford base32. IDs are safe as single path segments.
 */
export function createLiteIdentifier(
  prefix: LiteIdentifierPrefix,
  nowMilliseconds: number = Date.now(),
): string {
  return `${prefix}_${encodeTime(nowMilliseconds)}${encodeRandom()}`;
}

export function isLiteIdentifier(
  value: string,
  prefix?: LiteIdentifierPrefix,
): boolean {
  const expectedPrefix = prefix === undefined ? "(?:msg|tsk|mon|trn|pkg|ask)" : prefix;
  return new RegExp(`^${expectedPrefix}_[0-9A-HJKMNP-TV-Z]{${TOTAL_LENGTH}}$`, "u").test(value);
}
