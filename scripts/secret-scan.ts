import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { unzipSync } from "fflate";

type Options = Readonly<{ source: string; zip?: string; secretsFile?: string }>;
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

function parseArgs(args: ReadonlyArray<string>): Options {
  let source = ".";
  let zip = "dist/iwind-aifin-connector-skill.zip";
  let secretsFile: string | undefined;
  let sourceWasExplicit = false;
  let zipWasExplicit = false;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || !["--source", "--zip", "--secrets-file"].includes(flag ?? "")) {
      throw new Error("SECRET_SCAN_ERROR");
    }
    if (flag === "--source") {
      source = value;
      sourceWasExplicit = true;
    }
    if (flag === "--zip") {
      zip = value;
      zipWasExplicit = true;
    }
    if (flag === "--secrets-file") secretsFile = value;
  }
  return {
    source: path.resolve(source),
    ...(!sourceWasExplicit || zipWasExplicit ? { zip: path.resolve(zip) } : {}),
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
  const values: Uint8Array[] = [];
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7) : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(assignment.slice(0, separator))) {
      throw new Error("SECRET_SCAN_ERROR");
    }
    let value = assignment.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length < 8) throw new Error("SECRET_SCAN_ERROR");
    values.push(Buffer.from(value));
  }
  return values;
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
  const archive = unzipSync(await readFile(zipPath));
  const names = Object.keys(archive).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const findings: Finding[] = [];
  for (const name of names) {
    if (path.posix.isAbsolute(name) || name.split("/").includes("..")) {
      findings.push({ location: `${label}!/${name}`, rule: "SECRET_SCAN_ERROR" });
      continue;
    }
    const forbiddenRule = pathRule(name);
    if (forbiddenRule !== undefined) findings.push({ location: `${label}!/${name}`, rule: forbiddenRule });
    const bytes = archive[name];
    if (bytes === undefined) throw new Error("SECRET_SCAN_ERROR");
    findings.push(...scanBytes(bytes, `${label}!/${name}`, exactValues));
  }
  return { findings, entries: names.length };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const exactValues = await readExactValues(options.secretsFile);
  const sourceResult = await scanSource(options.source, exactValues);
  const zipResult =
    options.zip === undefined
      ? { findings: [], entries: 0 }
      : await scanZip(options.source, options.zip, exactValues);
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
