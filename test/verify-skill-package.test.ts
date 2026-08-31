import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { zipSync, type Zippable } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const VERIFY_SCRIPT = path.join(ROOT, "scripts", "verify-skill-package.ts");
const PACKAGE_FILES = [
  "SKILL.md",
  "evals/cross-tool-cases.json",
  "evals/notice-cases.json",
  "evals/routing-cases.json",
  "evals/trigger-cases.json",
  "references/analytics.md",
  "references/economic.md",
  "references/financial-docs.md",
  "references/fund.md",
  "references/index.md",
  "references/stock.md",
] as const;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("clean-room Skill package verification", () => {
  it("extracts and verifies the runtime-neutral archive without workspace dependencies", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "iwind-skill-archive-fixture-"));
    const cleanRoom = await mkdtemp(path.join(os.tmpdir(), "iwind-skill-clean-room-"));
    temporaryRoots.push(fixtureRoot, cleanRoom);
    const archive = path.join(fixtureRoot, "skill.zip");
    const entries: Zippable = {};
    for (const relative of PACKAGE_FILES) {
      entries[`iwind-aifin-connector/${relative}`] = await readFile(path.join(ROOT, "skill", relative));
    }
    await writeFile(archive, zipSync(entries));

    const verification = spawnSync(
      process.execPath,
      [TSX, VERIFY_SCRIPT, "--archive", archive, "--extract-to", cleanRoom],
      { cwd: cleanRoom, encoding: "utf8" },
    );

    expect(verification).toMatchObject({ status: 0, stderr: "" });
    expect(verification.stdout).toMatch(/^PACKAGE_VERIFY_OK files=11 sha256=[a-f0-9]{64}\n$/u);
    const skill = await readFile(path.join(cleanRoom, "iwind-aifin-connector", "SKILL.md"), "utf8");
    expect(skill).toContain("# iWind AIFin Connector");
  });

  it("creates a temporary clean room when only the archive is supplied", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "iwind-skill-archive-fixture-"));
    temporaryRoots.push(fixtureRoot);
    const archive = path.join(fixtureRoot, "skill.zip");
    const entries: Zippable = {};
    for (const relative of PACKAGE_FILES) {
      entries[`iwind-aifin-connector/${relative}`] = await readFile(path.join(ROOT, "skill", relative));
    }
    await writeFile(archive, zipSync(entries));

    const verification = spawnSync(
      process.execPath,
      [TSX, VERIFY_SCRIPT, "--archive", archive],
      { cwd: fixtureRoot, encoding: "utf8" },
    );

    expect(verification).toMatchObject({ status: 0, stderr: "" });
    expect(verification.stdout).toMatch(/^PACKAGE_VERIFY_OK files=11 sha256=[a-f0-9]{64}\n$/u);
    expect(await readdir(fixtureRoot)).toEqual(["skill.zip"]);
  });
});
