import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_SCRIPT = path.join(REPO_ROOT, "scripts", "package-skill.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const FIXED_ROOT = "iwind-aifin-connector";

type CommandResult = Readonly<{ status: number | null; stdout: string; stderr: string }>;

function runPackage(source: string, output: string): CommandResult {
  const result = spawnSync(process.execPath, [TSX_CLI, PACKAGE_SCRIPT, "--source", source, "--output", output], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
  it("creates byte-identical archives with the fixed allowlisted tree and metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "iwind-package-test-"));
    const first = path.join(root, "first.zip");
    const second = path.join(root, "second.zip");

    expect(runPackage(path.join(REPO_ROOT, "skill"), first)).toMatchObject({ status: 0, stderr: "" });
    expect(runPackage(path.join(REPO_ROOT, "skill"), second)).toMatchObject({ status: 0, stderr: "" });

    const firstBytes = await readFile(first);
    const secondBytes = await readFile(second);
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
    const result = runPackage(fixture.source, path.join(fixture.root, "out.zip"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PACKAGE_UNSAFE_SOURCE/u);
  });
});
