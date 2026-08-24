import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

import { inflateSync } from "fflate";

type Options = Readonly<{ source: string; zip: string; secretsFile?: string }>;
type Finding = Readonly<{ location: string; rule: string }>;

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".superpowers",
  ".worktrees",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);
const TEXT_RULES: ReadonlyArray<Readonly<{ id: string; pattern: RegExp }>> = [
  { id: "SECRET_TOKEN", pattern: /\bak_[A-Za-z0-9]+/u },
  { id: "SECRET_BEARER", pattern: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}\b/u },
  { id: "SECRET_PRIVATE_KEY", pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u },
];
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 256;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type ValidatedZipEntry = Readonly<{
  index: number;
  name: string;
  compression: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataOffset: number;
  dataEnd: number;
}>;

class ZipValidationError extends Error {
  constructor(readonly entryIndex?: number) {
    super("SECRET_SCAN_ERROR");
  }
}

function parseArgs(args: ReadonlyArray<string>): Options {
  let source = ".";
  let zip = "dist/iwind-aifin-connector-skill.zip";
  let secretsFile: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || !["--source", "--zip", "--secrets-file"].includes(flag ?? "")) {
      throw new Error("SECRET_SCAN_ERROR");
    }
    if (flag === "--source") {
      source = value;
    }
    if (flag === "--zip") {
      zip = value;
    }
    if (flag === "--secrets-file") secretsFile = value;
  }
  return {
    source: path.resolve(source),
    zip: path.resolve(zip),
    ...(secretsFile === undefined ? {} : { secretsFile: path.resolve(secretsFile) }),
  };
}

function relativeLabel(source: string, target: string): string {
  const relative = path.relative(source, target).split(path.sep).join("/");
  return relative === "" ? "." : relative.startsWith("../") ? path.basename(target) : relative;
}

function pathRule(relativePath: string): string | undefined {
  const parts = relativePath.split("/");
  if (parts.includes(".secrets")) return "SECRET_DIRECTORY_PATH";
  if (parts.some((part) => part === ".dev.vars" || (part.startsWith(".dev.vars.") && part !== ".dev.vars.example"))) {
    return "SECRET_DEV_VARS_PATH";
  }
  return undefined;
}

function scanBytes(
  bytes: Uint8Array,
  location: string,
  exactValues: ReadonlyArray<Uint8Array>,
): ReadonlyArray<Finding> {
  const findings: Finding[] = [];
  const text = new TextDecoder().decode(bytes);
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) findings.push({ location, rule: rule.id });
  }
  if (exactValues.some((value) => Buffer.from(bytes).includes(Buffer.from(value)))) {
    findings.push({ location, rule: "SECRET_EXACT_VALUE" });
  }
  return findings;
}

async function readExactValues(file: string | undefined): Promise<ReadonlyArray<Uint8Array>> {
  if (file === undefined) return [];
  const source = await readFile(file, "utf8");
  const declaredKeys = new Set<string>();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7) : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(assignment);
    if (match === null) throw new Error("SECRET_SCAN_ERROR");
    declaredKeys.add(match[1] ?? "");
    assertSupportedValueSyntax(match[2] ?? "");
  }
  const parsed = parseEnv(source);
  if (declaredKeys.size === 0 || [...declaredKeys].some((key) => !(key in parsed))) {
    throw new Error("SECRET_SCAN_ERROR");
  }
  const values: Uint8Array[] = [];
  for (const value of Object.values(parsed)) {
    if (value === undefined || value.length < 8) throw new Error("SECRET_SCAN_ERROR");
    values.push(Buffer.from(value));
  }
  if (values.length === 0) throw new Error("SECRET_SCAN_ERROR");
  return values;
}

function assertSupportedValueSyntax(rawValue: string): void {
  const value = rawValue.trimStart();
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") throw new Error("SECRET_SCAN_ERROR");
    if (character !== quote) continue;
    const trailing = value.slice(index + 1).trim();
    if (trailing === "" || trailing.startsWith("#")) return;
    throw new Error("SECRET_SCAN_ERROR");
  }
  throw new Error("SECRET_SCAN_ERROR");
}

async function scanSource(
  source: string,
  exactValues: ReadonlyArray<Uint8Array>,
): Promise<Readonly<{ findings: ReadonlyArray<Finding>; files: number }>> {
  const rootInfo = await lstat(source);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("SECRET_SCAN_ERROR");
  const findings: Finding[] = [];
  let files = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(source, absolute).split(path.sep).join("/");
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        findings.push({ location: relative, rule: "SECRET_SCAN_ERROR" });
        continue;
      }
      const forbiddenRule = pathRule(relative);
      if (forbiddenRule !== undefined) findings.push({ location: relative, rule: forbiddenRule });
      if (info.isDirectory()) {
        await walk(absolute);
      } else {
        files += 1;
        findings.push(...scanBytes(await readFile(absolute), relative, exactValues));
      }
    }
  }

  await walk(source);
  return { findings, files };
}

async function scanZip(
  source: string,
  zipPath: string,
  exactValues: ReadonlyArray<Uint8Array>,
): Promise<Readonly<{ findings: ReadonlyArray<Finding>; entries: number }>> {
  const label = relativeLabel(source, zipPath);
  try {
    const info = await lstat(zipPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARCHIVE_BYTES) {
      throw new ZipValidationError();
    }
    const archive = await readFile(zipPath);
    const entries = validateCentralDirectory(archive);
    const findings: Finding[] = [];
    for (const entry of entries) {
      const location = `${label}!/${entry.name}`;
      const forbiddenRule = pathRule(entry.name);
      if (forbiddenRule !== undefined) findings.push({ location, rule: forbiddenRule });
      const bytes = extractEntry(archive, entry);
      findings.push(...scanBytes(bytes, location, exactValues));
    }
    return { findings, entries: entries.length };
  } catch (error) {
    const entryIndex = error instanceof ZipValidationError ? error.entryIndex : undefined;
    const location = entryIndex === undefined ? `${label}!/.` : `${label}!/#entry-${entryIndex + 1}`;
    return { findings: [{ location, rule: "SECRET_SCAN_ERROR" }], entries: 0 };
  }
}

function validateCentralDirectory(archive: Uint8Array): ReadonlyArray<ValidatedZipEntry> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocdOffset = findEndOfCentralDirectory(archive, view);
  const diskNumber = readUint16(view, eocdOffset + 4);
  const centralDisk = readUint16(view, eocdOffset + 6);
  const entriesOnDisk = readUint16(view, eocdOffset + 8);
  const entryCount = readUint16(view, eocdOffset + 10);
  const centralSize = readUint32(view, eocdOffset + 12);
  const centralOffset = readUint32(view, eocdOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0 ||
    entryCount === 0xffff ||
    entryCount > MAX_ZIP_ENTRIES ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== eocdOffset
  ) {
    throw new ZipValidationError();
  }

  const entries: ValidatedZipEntry[] = [];
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  let totalUncompressed = 0;
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(archive, cursor, 46, index);
    if (readUint32(view, cursor) !== 0x02014b50) throw new ZipValidationError(index);
    const madeBy = readUint16(view, cursor + 4);
    const flags = readUint16(view, cursor + 8);
    const compression = readUint16(view, cursor + 10);
    const crc = readUint32(view, cursor + 16);
    const compressedSize = readUint32(view, cursor + 20);
    const uncompressedSize = readUint32(view, cursor + 24);
    const nameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const startDisk = readUint16(view, cursor + 34);
    const externalAttributes = readUint32(view, cursor + 38);
    const localOffset = readUint32(view, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    assertRange(archive, cursor, recordLength, index);
    if (
      cursor + recordLength > centralEnd ||
      nameLength === 0 ||
      startDisk !== 0 ||
      (flags & ~0x0800) !== 0 ||
      (compression !== 0 && compression !== 8) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES ||
      localOffset === 0xffffffff
    ) {
      throw new ZipValidationError(index);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new ZipValidationError(index);

    const name = decodeEntryName(archive.subarray(cursor + 46, cursor + 46 + nameLength), index);
    assertSafeEntryName(name, index);
    assertOrdinaryFile(madeBy, externalAttributes, index);
    if (names.has(name) || localOffsets.has(localOffset)) throw new ZipValidationError(index);
    names.add(name);
    localOffsets.add(localOffset);

    const local = validateLocalHeader(
      archive,
      view,
      centralOffset,
      index,
      name,
      flags,
      compression,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    );
    entries.push({
      index,
      name,
      compression,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset: local.dataOffset,
      dataEnd: local.dataEnd,
    });
    cursor += recordLength;
  }
  if (cursor !== centralEnd) throw new ZipValidationError();
  const localRanges = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  for (let index = 1; index < localRanges.length; index += 1) {
    const previous = localRanges[index - 1];
    const current = localRanges[index];
    if (previous === undefined || current === undefined || previous.dataEnd > current.localOffset) {
      throw new ZipValidationError(current?.index);
    }
  }
  return entries;
}

function findEndOfCentralDirectory(archive: Uint8Array, view: DataView): number {
  if (archive.length < 22) throw new ZipValidationError();
  const minimum = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (readUint32(view, offset) !== 0x06054b50) continue;
    const commentLength = readUint16(view, offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new ZipValidationError();
}

function validateLocalHeader(
  archive: Uint8Array,
  view: DataView,
  centralOffset: number,
  index: number,
  name: string,
  flags: number,
  compression: number,
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
  localOffset: number,
): Readonly<{ dataOffset: number; dataEnd: number }> {
  assertRange(archive, localOffset, 30, index);
  if (
    readUint32(view, localOffset) !== 0x04034b50 ||
    readUint16(view, localOffset + 6) !== flags ||
    readUint16(view, localOffset + 8) !== compression ||
    readUint32(view, localOffset + 14) !== crc ||
    readUint32(view, localOffset + 18) !== compressedSize ||
    readUint32(view, localOffset + 22) !== uncompressedSize
  ) {
    throw new ZipValidationError(index);
  }
  const nameLength = readUint16(view, localOffset + 26);
  const extraLength = readUint16(view, localOffset + 28);
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + compressedSize;
  assertRange(archive, localOffset, 30 + nameLength + extraLength + compressedSize, index);
  if (dataEnd > centralOffset) throw new ZipValidationError(index);
  const localName = decodeEntryName(
    archive.subarray(localOffset + 30, localOffset + 30 + nameLength),
    index,
  );
  if (localName !== name) throw new ZipValidationError(index);
  return { dataOffset, dataEnd };
}

function extractEntry(archive: Uint8Array, entry: ValidatedZipEntry): Uint8Array {
  try {
    const compressed = archive.subarray(entry.dataOffset, entry.dataEnd);
    const bytes =
      entry.compression === 0
        ? compressed.slice()
        : inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize + 1) });
    if (
      bytes.length !== entry.uncompressedSize ||
      (entry.compression === 0 && entry.compressedSize !== entry.uncompressedSize) ||
      crc32(bytes) !== entry.crc32
    ) {
      throw new ZipValidationError(entry.index);
    }
    return bytes;
  } catch (error) {
    if (error instanceof ZipValidationError) throw error;
    throw new ZipValidationError(entry.index);
  }
}

function assertSafeEntryName(name: string, index: number): void {
  const segments = name.split("/");
  if (
    name === "" ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/u.test(name) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ZipValidationError(index);
  }
}

function assertOrdinaryFile(madeBy: number, externalAttributes: number, index: number): void {
  const operatingSystem = madeBy >>> 8;
  if (operatingSystem === 3 || operatingSystem === 19) {
    const fileType = (externalAttributes >>> 16) & 0o170000;
    if (fileType !== 0o100000) throw new ZipValidationError(index);
    return;
  }
  if ((externalAttributes & 0x10) !== 0) throw new ZipValidationError(index);
}

function decodeEntryName(bytes: Uint8Array, index: number): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new ZipValidationError(index);
  }
}

function assertRange(archive: Uint8Array, offset: number, length: number, index?: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > archive.length) {
    throw new ZipValidationError(index);
  }
}

function readUint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new ZipValidationError();
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new ZipValidationError();
  return view.getUint32(offset, true);
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const exactValues = await readExactValues(options.secretsFile);
  const sourceResult = await scanSource(options.source, exactValues);
  const zipResult = await scanZip(options.source, options.zip, exactValues);
  const findings = [...sourceResult.findings, ...zipResult.findings]
    .filter((finding, index, all) =>
      all.findIndex((candidate) => candidate.location === finding.location && candidate.rule === finding.rule) === index,
    )
    .sort((left, right) =>
      Buffer.from(`${left.location}\0${left.rule}`).compare(Buffer.from(`${right.location}\0${right.rule}`)),
    );
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${finding.location} ${finding.rule}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`SECRET_SCAN_OK files=${sourceResult.files} zip_entries=${zipResult.entries}\n`);
}

try {
  await main();
} catch {
  process.stderr.write(". SECRET_SCAN_ERROR\n");
  process.exitCode = 1;
}
