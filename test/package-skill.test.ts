import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_SCRIPT = path.join(REPO_ROOT, "scripts", "package-skill.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FIXED_ROOT = "iwind-aifin-connector";
const PACKAGE_OUTPUT = path.join(REPO_ROOT, "dist", "iwind-aifin-connector-skill.zip");
const LEGACY_TEMP = `${PACKAGE_OUTPUT}.tmp`;

type CommandResult = Readonly<{ status: number | null; stdout: string; stderr: string }>;

function runPackage(args: ReadonlyArray<string> = []): CommandResult {
  const result = spawnSync(process.execPath, [TSX_CLI, PACKAGE_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function removePath(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isDirectory() && !info.isSymbolicLink()) await rm(target, { recursive: true });
    else await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function centralDirectory(bytes: Uint8Array): ReadonlyArray<{
  name: string;
  modifiedTime: number;
  modifiedDate: number;
  externalAttributes: number;
}> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = [];
  for (let offset = 0; offset <= bytes.length - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      modifiedTime: view.getUint16(offset + 12, true),
      modifiedDate: view.getUint16(offset + 14, true),
      externalAttributes: view.getUint32(offset + 38, true),
    });
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function tempSkill(): Promise<Readonly<{ root: string; source: string }>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "iwind-package-test-"));
  const source = path.join(root, "skill");
  await cp(path.join(REPO_ROOT, "skill"), source, { recursive: true });
  return { root, source };
}

describe("deterministic Skill packaging", () => {
  beforeEach(async () => {
    await mkdir(path.dirname(PACKAGE_OUTPUT), { recursive: true });
    await removePath(PACKAGE_OUTPUT);
    await removePath(LEGACY_TEMP);
  });

  afterEach(async () => {
    await removePath(PACKAGE_OUTPUT);
    await removePath(LEGACY_TEMP);
  });

  it("creates byte-identical archives with the fixed allowlisted tree and metadata", async () => {
    expect(runPackage()).toMatchObject({ status: 0, stderr: "" });
    const firstBytes = await readFile(PACKAGE_OUTPUT);
    expect(runPackage()).toMatchObject({ status: 0, stderr: "" });
    const secondBytes = await readFile(PACKAGE_OUTPUT);
    expect(sha256(firstBytes)).toBe(sha256(secondBytes));
    expect(firstBytes).toEqual(secondBytes);

    const references = ["analytics.md", "economic.md", "financial-docs.md", "fund.md", "index.md", "stock.md"];
    const evals = ["cross-tool-cases.json", "notice-cases.json", "routing-cases.json", "trigger-cases.json"];
    const expected = [
      `${FIXED_ROOT}/SKILL.md`,
      ...evals.map((name) => `${FIXED_ROOT}/evals/${name}`),
      ...references.map((name) => `${FIXED_ROOT}/references/${name}`),
    ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    const archive = unzipSync(firstBytes);
    expect(Object.keys(archive)).toEqual(expected);
    for (const name of expected) {
      expect(Buffer.from(archive[name] ?? [])).toEqual(
        await readFile(path.join(REPO_ROOT, "skill", name.slice(FIXED_ROOT.length + 1))),
      );
      expect(name.startsWith("/")).toBe(false);
      expect(name.split("/")).not.toContain("..");
    }

    const metadata = centralDirectory(firstBytes);
    expect(metadata.map((entry) => entry.name)).toEqual(expected);
    for (const entry of metadata) {
      expect(entry.modifiedTime).toBe(0);
      expect(entry.modifiedDate).toBe(0x21);
      expect(entry.externalAttributes >>> 16).toBe(0o100644);
    }
  });

  it("binds the rotated-success notice to the actual runtime Skill package without platform branches", async () => {
    expect(runPackage()).toMatchObject({ status: 0, stderr: "" });
    const archive = unzipSync(await readFile(PACKAGE_OUTPUT));
    const skill = decodeArchiveEntry(archive, `${FIXED_ROOT}/SKILL.md`);
    const noticeCases = JSON.parse(
      decodeArchiveEntry(archive, `${FIXED_ROOT}/evals/notice-cases.json`),
    ) as Array<{
      id: string;
      notice: { code: string } | null;
      operationsSentence: string | null;
    }>;
    const rotated = noticeCases.find(({ notice }) => notice?.code === "WIND_KEY_ROTATED");

    expect(rotated?.id).toBe("rotated-success");
    expect(rotated?.operationsSentence).toMatch(/自动轮换/);
    expect(skill).toContain(rotated?.operationsSentence);
    expect(skill).not.toMatch(/ChatGPT|Grok|Claude|Gemini/iu);
  });

  it.each([
    ["hidden file", async (source: string) => writeFile(path.join(source, ".unexpected"), "x")],
    ["unexpected file", async (source: string) => writeFile(path.join(source, "notes.md"), "x")],
    ["source map", async (source: string) => writeFile(path.join(source, "references", "leak.js.map"), "{}")],
    ["unexpected directory", async (source: string) => mkdir(path.join(source, "node_modules"))],
    ["nested reference directory", async (source: string) => mkdir(path.join(source, "references", "nested"))],
    ["symbolic link", async (source: string) => symlink("SKILL.md", path.join(source, "linked-skill.md"))],
  ])("rejects a %s instead of silently changing package scope", async (_label, mutate) => {
    const fixture = await tempSkill();
    await mutate(fixture.source);
    const result = runPackage(["--source", fixture.source]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PACKAGE_UNSAFE_SOURCE/u);
  });

  it("rejects an output override before it can replace a source file", async () => {
    const sourcePath = path.join(REPO_ROOT, "skill", "SKILL.md");
    const sourceBefore = await readFile(sourcePath);

    const result = runPackage(["--output", sourcePath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("PACKAGE_UNSAFE_SOURCE\n");
    await expect(readFile(sourcePath)).resolves.toEqual(sourceBefore);
  });

  it("does not follow a pre-seeded predictable temp symlink into source", async () => {
    const fixture = await tempSkill();
    const protectedSource = path.join(fixture.source, "SKILL.md");
    const sourceBefore = await readFile(protectedSource);
    await symlink(protectedSource, LEGACY_TEMP);

    const result = runPackage(["--source", fixture.source]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    await expect(readFile(protectedSource)).resolves.toEqual(sourceBefore);
    expect((await lstat(LEGACY_TEMP)).isSymbolicLink()).toBe(true);
  });

  it.each(["symlink", "directory"])("rejects a final output %s conflict without touching source", async (kind) => {
    const fixture = await tempSkill();
    const protectedSource = path.join(fixture.source, "SKILL.md");
    const sourceBefore = await readFile(protectedSource);
    if (kind === "symlink") await symlink(protectedSource, PACKAGE_OUTPUT);
    else await mkdir(PACKAGE_OUTPUT);

    const result = runPackage(["--source", fixture.source]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("PACKAGE_UNSAFE_SOURCE\n");
    await expect(readFile(protectedSource)).resolves.toEqual(sourceBefore);
    expect((await readdir(path.dirname(PACKAGE_OUTPUT))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("atomically replaces a normal fixed output without leaving temp files", async () => {
    await writeFile(PACKAGE_OUTPUT, "stale generated output");
    const result = runPackage();

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(Object.keys(unzipSync(await readFile(PACKAGE_OUTPUT)))).toContain(`${FIXED_ROOT}/SKILL.md`);
    expect((await readdir(path.dirname(PACKAGE_OUTPUT))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

function decodeArchiveEntry(
  archive: Readonly<Record<string, Uint8Array>>,
  entry: string,
): string {
  const bytes = archive[entry];
  if (bytes === undefined) throw new Error(`missing package entry: ${entry}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
