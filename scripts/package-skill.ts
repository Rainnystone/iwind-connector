import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { zipSync, type Zippable } from "fflate";

import { safeAtomicWrite } from "./safe-atomic-write.js";

const FIXED_ROOT = "iwind-aifin-connector";
const FIXED_MTIME = new Date(1980, 0, 1, 0, 0, 0, 0);
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT_DIRECTORY = path.join(REPO_ROOT, "dist");
const OUTPUT = path.join(OUTPUT_DIRECTORY, "iwind-aifin-connector-skill.zip");

type Options = Readonly<{ source: string }>;

function parseArgs(args: ReadonlyArray<string>): Options {
  let source = "skill";
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || flag !== "--source") {
      throw new Error("PACKAGE_USAGE");
    }
    if (flag === "--source") source = value;
  }
  return { source: path.resolve(source) };
}

function utf8Compare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function assertSafeRelative(relativePath: string): void {
  const normalized = relativePath.split(path.sep).join("/");
  const parts = normalized.split("/");
  if (
    path.isAbsolute(relativePath) ||
    parts.includes("..") ||
    parts.some((part) => part.startsWith(".")) ||
    parts.includes("node_modules") ||
    normalized.endsWith(".map")
  ) {
    throw new Error("PACKAGE_UNSAFE_SOURCE");
  }
}

function classify(relativePath: string, directory: boolean): "include" | "known-excluded" {
  const normalized = relativePath.split(path.sep).join("/");
  const [top, ...rest] = normalized.split("/");
  if (normalized === "test") {
    if (!directory) throw new Error("PACKAGE_UNSAFE_SOURCE");
    return "known-excluded";
  }
  if (top === "test") return "known-excluded";
  if (normalized === "SKILL.md" && !directory) return "include";
  if (
    (normalized === "references" && directory) ||
    (top === "references" && !directory && rest.length === 1 && rest[0]?.endsWith(".md"))
  ) {
    return "include";
  }
  if (
    (normalized === "evals" && directory) ||
    (top === "evals" && !directory && rest.length === 1 && rest[0]?.endsWith(".json"))
  ) {
    return "include";
  }
  throw new Error("PACKAGE_UNSAFE_SOURCE");
}

async function collectFiles(source: string): Promise<ReadonlyArray<string>> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("PACKAGE_UNSAFE_SOURCE");
  const included: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => utf8Compare(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(source, absolute);
      assertSafeRelative(relative);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error("PACKAGE_UNSAFE_SOURCE");
      }
      const classification = classify(relative, info.isDirectory());
      if (info.isDirectory()) {
        await walk(absolute);
      } else if (classification === "include") {
        included.push(relative.split(path.sep).join("/"));
      }
    }
  }

  await walk(source);
  included.sort(utf8Compare);
  if (
    !included.includes("SKILL.md") ||
    !included.some((name) => name.startsWith("references/")) ||
    !included.some((name) => name.startsWith("evals/"))
  ) {
    throw new Error("PACKAGE_UNSAFE_SOURCE");
  }
  return included;
}

async function packageSkill(options: Options): Promise<void> {
  const files = await collectFiles(options.source);
  const archive: Zippable = {};
  for (const relative of files) {
    const entry = `${FIXED_ROOT}/${relative}`;
    archive[entry] = [
      await readFile(path.join(options.source, relative)),
      { attrs: FILE_ATTRIBUTES, level: 9, mtime: FIXED_MTIME, os: 3 },
    ];
  }
  const bytes = zipSync(archive, { attrs: FILE_ATTRIBUTES, level: 9, mtime: FIXED_MTIME, os: 3 });
  await safeAtomicWrite({
    target: OUTPUT,
    expectedTarget: OUTPUT,
    allowedDirectory: OUTPUT_DIRECTORY,
    protectedPaths: [options.source, path.join(REPO_ROOT, "skill")],
    data: bytes,
  });
  process.stdout.write(`PACKAGE_OK ${path.basename(OUTPUT)} files=${files.length}\n`);
}

try {
  await packageSkill(parseArgs(process.argv.slice(2)));
} catch {
  process.stderr.write("PACKAGE_UNSAFE_SOURCE\n");
  process.exitCode = 1;
}
