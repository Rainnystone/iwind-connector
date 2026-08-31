import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unzipSync } from "fflate";

const FIXED_ROOT = "iwind-aifin-connector";
const EXPECTED_ENTRIES = [
  `${FIXED_ROOT}/SKILL.md`,
  `${FIXED_ROOT}/evals/cross-tool-cases.json`,
  `${FIXED_ROOT}/evals/notice-cases.json`,
  `${FIXED_ROOT}/evals/routing-cases.json`,
  `${FIXED_ROOT}/evals/trigger-cases.json`,
  `${FIXED_ROOT}/references/analytics.md`,
  `${FIXED_ROOT}/references/economic.md`,
  `${FIXED_ROOT}/references/financial-docs.md`,
  `${FIXED_ROOT}/references/fund.md`,
  `${FIXED_ROOT}/references/index.md`,
  `${FIXED_ROOT}/references/stock.md`,
] as const;

type Inputs = Readonly<{ archive: string; extractTo: string | null }>;
type VerificationInputs = Readonly<{ archive: string; extractTo: string }>;

function parseArgs(args: ReadonlyArray<string>): Inputs {
  if (args.length !== 2 && args.length !== 4) throw new Error("PACKAGE_VERIFY_INVALID");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      value === undefined ||
      (flag !== "--archive" && flag !== "--extract-to") ||
      values.has(flag)
    ) {
      throw new Error("PACKAGE_VERIFY_INVALID");
    }
    values.set(flag, value);
  }
  const archive = values.get("--archive");
  const extractTo = values.get("--extract-to");
  if (archive === undefined || (args.length === 4 && extractTo === undefined)) {
    throw new Error("PACKAGE_VERIFY_INVALID");
  }
  return {
    archive: path.resolve(archive),
    extractTo: extractTo === undefined ? null : path.resolve(extractTo),
  };
}

function sortedUtf8(values: ReadonlyArray<string>): string[] {
  return [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function assertSafeText(entry: string, source: string): void {
  if (
    /(?:^|[\s"'(])(?:\/Users\/|\/home\/|[A-Za-z]:\\)|node_modules|\.secrets(?:\/|\b)|openai\.yaml|(?:^|\/)agents\//imu.test(
      source,
    ) ||
    /https?:\/\//iu.test(source) ||
    /\b(?:ChatGPT|Grok)\b/iu.test(source)
  ) {
    throw new Error("PACKAGE_VERIFY_INVALID");
  }
  if (entry.endsWith(".json")) JSON.parse(source);
  for (const match of source.matchAll(/\]\(([^)]+)\)/gu)) {
    const target = match[1]?.split("#", 1)[0] ?? "";
    if (target === "") continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), target));
    if (!resolved.startsWith(`${FIXED_ROOT}/`) || resolved.includes("..")) {
      throw new Error("PACKAGE_VERIFY_INVALID");
    }
  }
}

async function verify(inputs: VerificationInputs): Promise<void> {
  if ((await readdir(inputs.extractTo)).length !== 0) throw new Error("PACKAGE_VERIFY_INVALID");
  const archiveBytes = await readFile(inputs.archive);
  const archive = unzipSync(archiveBytes);
  const names = sortedUtf8(Object.keys(archive));
  if (JSON.stringify(names) !== JSON.stringify(sortedUtf8(EXPECTED_ENTRIES))) {
    throw new Error("PACKAGE_VERIFY_INVALID");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const entry of names) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new Error("PACKAGE_VERIFY_INVALID");
    }
    const bytes = archive[entry];
    if (bytes === undefined) throw new Error("PACKAGE_VERIFY_INVALID");
    const source = decoder.decode(bytes);
    assertSafeText(entry, source);
    const target = path.join(inputs.extractTo, ...entry.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o644 });
    if (!Buffer.from(await readFile(target)).equals(Buffer.from(bytes))) {
      throw new Error("PACKAGE_VERIFY_INVALID");
    }
  }

  const hash = createHash("sha256").update(archiveBytes).digest("hex");
  process.stdout.write(`PACKAGE_VERIFY_OK files=${names.length} sha256=${hash}\n`);
}

async function run(inputs: Inputs): Promise<void> {
  if (inputs.extractTo !== null) {
    await verify({ archive: inputs.archive, extractTo: inputs.extractTo });
    return;
  }
  const cleanRoom = await mkdtemp(path.join(os.tmpdir(), "iwind-skill-clean-room-"));
  try {
    await verify({ archive: inputs.archive, extractTo: cleanRoom });
  } finally {
    await rm(cleanRoom, { recursive: true });
  }
}

try {
  await run(parseArgs(process.argv.slice(2)));
} catch {
  process.stderr.write("PACKAGE_VERIFY_INVALID\n");
  process.exitCode = 1;
}
