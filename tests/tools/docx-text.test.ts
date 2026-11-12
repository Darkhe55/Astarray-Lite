import { describe, expect, it } from "vitest";

import { extractDocxText } from "../../src/tools/builtin/docx-text.js";

function zipEntry(name: string, content: string): { local: Buffer; central: Buffer } {
  const nameBuffer = Buffer.from(name, "utf8");
  const data = Buffer.from(content, "utf8");
  const local = Buffer.alloc(30 + nameBuffer.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuffer.copy(local, 30);
  data.copy(local, 30 + nameBuffer.length);

  const central = Buffer.alloc(46 + nameBuffer.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  nameBuffer.copy(central, 46);
  return { local, central };
}

function docx(xml: string): Buffer {
  const entry = zipEntry("word/document.xml", xml);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(entry.central.length, 12);
  eocd.writeUInt32LE(entry.local.length, 16);
  return Buffer.concat([entry.local, entry.central, eocd]);
}

describe("DOCX text extraction", () => {
  it("extracts paragraph text and entities", () => {
    const xml = [
      "<w:document><w:body>",
      "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>World &amp; more</w:t></w:r></w:p>",
      "</w:body></w:document>",
    ].join("");
    expect(extractDocxText(docx(xml))).toBe("Hello\nWorld & more");
  });

  it("rejects a non-zip buffer", () => {
    expect(() => extractDocxText(Buffer.from("not a docx"))).toThrow(/DOCX/u);
  });
});
