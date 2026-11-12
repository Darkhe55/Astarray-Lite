import { inflateRawSync } from "node:zlib";

import { LiteError } from "../../contracts/errors.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_XML_BYTES = 16 * 1024 * 1024;

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/gu, "&");
}

function xmlToText(xml: string): string {
  return xml
    .split(/<\/w:p>/u)
    .map((paragraph) => {
      const pieces: string[] = [];
      const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu;
      for (const match of paragraph.matchAll(pattern)) {
        pieces.push(decodeXmlEntities(match[1] ?? ""));
      }
      return pieces.join("");
    })
    .filter((line) => line !== "")
    .join("\n")
    .trimEnd();
}

/**
 * Reads word/document.xml from a DOCX zip in memory. No entry is written to
 * disk, so archive entry names cannot escape a directory.
 */
export function extractDocxText(buffer: Buffer): string {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new LiteError("LITE_FILE_BINARY_UNSUPPORTED", "DOCX zip directory not found");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) break;
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name !== "word/document.xml") continue;
    if (localOffset + 30 > buffer.length) break;
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new LiteError("LITE_FILE_BINARY_UNSUPPORTED", "invalid DOCX local header");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    let xml: string;
    if (method === 0) {
      xml = data.toString("utf8");
    } else if (method === 8) {
      if (data.length > MAX_XML_BYTES) {
        throw new LiteError("LITE_FILE_TOO_LARGE", "DOCX document XML is too large");
      }
      xml = inflateRawSync(data).toString("utf8");
    } else {
      throw new LiteError("LITE_FILE_BINARY_UNSUPPORTED", "unsupported DOCX compression method");
    }
    return xmlToText(xml);
  }
  throw new LiteError("LITE_FILE_BINARY_UNSUPPORTED", "DOCX document XML not found");
}
