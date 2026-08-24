import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCAN_SCRIPT = path.join(REPO_ROOT, "scripts", "secret-scan.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

type CommandResult = Readonly<{ status: number | null; stdout: string; stderr: string }>;

function runScan(args: ReadonlyArray<string>): CommandResult {
  const result = spawnSync(process.execPath, [TSX_CLI, SCAN_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function emptyRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "iwind-secret-scan-test-"));
}

describe("fail-closed Secret scanner", () => {
  it.each([
    ["SECRET_TOKEN", "token.txt", ["ak", "fixture", "1234567890abcdefghijklmnop"].join("_")],
    ["SECRET_BEARER", "headers.txt", `Bearer ${"A1b2C3d4".repeat(5)}`],
    [
      "SECRET_PRIVATE_KEY",
      "key.pem",
      ["-----BEGIN ", "PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----"].join(""),
    ],
  ])("rejects source bytes by stable rule %s without emitting the matched value", async (rule, name, secret) => {
    const root = await emptyRoot();
    await writeFile(path.join(root, name), secret);

    const result = runScan(["--source", root]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${name} ${rule}`);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it.each([
    ["SECRET_DEV_VARS_PATH", ".dev.vars"],
    ["SECRET_DIRECTORY_PATH", path.join(".secrets", "keys.env")],
  ])("rejects forbidden source path by stable rule %s", async (rule, relativePath) => {
    const root = await emptyRoot();
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "harmless=true\n");

    const result = runScan(["--source", root]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${relativePath.split(path.sep).join("/")} ${rule}`);
    expect(result.stderr).not.toContain("harmless=true");
  });

  it("scans real zip entry bytes and reports only archive-relative location plus rule ID", async () => {
    const root = await emptyRoot();
    const zipPath = path.join(root, "artifact.zip");
    const secret = `Bearer ${"Z9y8X7w6".repeat(5)}`;
    await writeFile(zipPath, zipSync({ "iwind-aifin-connector/reference.md": strToU8(secret) }));

    const result = runScan(["--source", root, "--zip", zipPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("artifact.zip!/iwind-aifin-connector/reference.md SECRET_BEARER");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("uses caller-supplied env values for exact matching without emitting the value", async () => {
    const root = await emptyRoot();
    const secretsFile = path.join(await emptyRoot(), "iwind.keys.env");
    const secret = ["exact", "fixture", "value", "0123456789abcdef"].join("-");
    await writeFile(secretsFile, `WIND_API_KEY_01=${secret}\n`);
    await writeFile(path.join(root, "leak.txt"), `prefix:${secret}:suffix`);

    const result = runScan(["--source", root, "--secrets-file", secretsFile]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("leak.txt SECRET_EXACT_VALUE");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("fails closed when a non-comment secrets-file line is not an env assignment", async () => {
    const root = await emptyRoot();
    const secretsFile = path.join(await emptyRoot(), "iwind.keys.env");
    await writeFile(secretsFile, "this is not an env assignment\n");

    const result = runScan(["--source", root, "--secrets-file", secretsFile]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe(". SECRET_SCAN_ERROR\n");
  });

  it.each(["missing source", "malformed archive"])("fails closed for %s", async (label) => {
    const root = await emptyRoot();
    const brokenZip = path.join(root, "broken.zip");
    if (label === "malformed archive") await writeFile(brokenZip, "not a zip");
    const args =
      label === "malformed archive"
        ? ["--source", root, "--zip", brokenZip]
        : ["--source", "/definitely/not/a/real/iwind-scan-root"];
    const result = runScan(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/SECRET_SCAN_ERROR/u);
  });

  it("passes clean source and archive bytes", async () => {
    const root = await emptyRoot();
    const zipPath = path.join(root, "clean.zip");
    await writeFile(path.join(root, "README.md"), "Public connector instructions.\n");
    await writeFile(zipPath, zipSync({ "iwind-aifin-connector/SKILL.md": strToU8("Clean instructions.\n") }));

    const result = runScan(["--source", root, "--zip", zipPath]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toMatch(/SECRET_SCAN_OK/u);
  });
});
