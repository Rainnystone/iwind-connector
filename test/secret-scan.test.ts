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

function runScan(args: ReadonlyArray<string>, cwd = REPO_ROOT): CommandResult {
  const result = spawnSync(process.execPath, [TSX_CLI, SCAN_SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function patchCentralUint32(
  archive: Uint8Array,
  fieldOffset: number,
  value: number,
  entryIndexes?: ReadonlySet<number>,
): Uint8Array {
  const patched = archive.slice();
  const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
  let entryIndex = 0;
  for (let offset = 0; offset <= patched.length - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    if (entryIndexes === undefined || entryIndexes.has(entryIndex)) {
      view.setUint32(offset + fieldOffset, value, true);
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 45 + nameLength + extraLength + commentLength;
    entryIndex += 1;
  }
  return patched;
}

function replaceAscii(archive: Uint8Array, from: string, to: string): Uint8Array {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const patched = Buffer.from(archive);
  const needle = Buffer.from(from);
  const replacement = Buffer.from(to);
  let replacements = 0;
  for (let offset = patched.indexOf(needle); offset !== -1; offset = patched.indexOf(needle, offset + replacement.length)) {
    replacement.copy(patched, offset);
    replacements += 1;
  }
  expect(replacements).toBe(2);
  return patched;
}

async function emptyRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "iwind-secret-scan-test-"));
}

async function cleanZip(root: string, name = "clean.zip"): Promise<string> {
  const zipPath = path.join(root, name);
  await writeFile(zipPath, zipSync({ "iwind-aifin-connector/SKILL.md": strToU8("Clean instructions.\n") }));
  return zipPath;
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
    const zipPath = await cleanZip(root);

    const result = runScan(["--source", root, "--zip", zipPath]);
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
    const zipPath = await cleanZip(root);

    const result = runScan(["--source", root, "--zip", zipPath]);
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

  it.each([
    [
      "duplicate entry",
      () =>
        replaceAscii(
          zipSync({ "root/one.txt": strToU8("first"), "root/two.txt": strToU8("second") }),
          "two.txt",
          "one.txt",
        ),
    ],
    [
      "Unix symlink entry",
      () =>
        zipSync({
          "root/link": [strToU8("target"), { os: 3, attrs: (0o120777 << 16) >>> 0 }],
        }),
    ],
    ["backslash traversal", () => zipSync({ "root\\..\\escape.txt": strToU8("clean") })],
    ["drive-letter path", () => zipSync({ "C:/escape.txt": strToU8("clean") })],
    ["absolute path", () => zipSync({ "/escape.txt": strToU8("clean") })],
    ["dot segment", () => zipSync({ "root/./escape.txt": strToU8("clean") })],
    ["parent segment", () => zipSync({ "root/../escape.txt": strToU8("clean") })],
    [
      "single-entry size declaration above 1 MiB",
      () => patchCentralUint32(zipSync({ "root/file.txt": strToU8("clean") }), 24, 1024 * 1024 + 1),
    ],
    [
      "total size declaration above 8 MiB",
      () => {
        const files = Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [`root/file-${index}.txt`, strToU8("clean")] as const),
        );
        return patchCentralUint32(zipSync(files), 24, 1024 * 1024);
      },
    ],
    [
      "entry count above 256",
      () =>
        zipSync(
          Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [`root/file-${index}.txt`, strToU8("clean")] as const),
          ),
        ),
    ],
  ])("rejects unsafe central-directory metadata for %s before scanning bytes", async (_label, buildArchive) => {
    const root = await emptyRoot();
    const zipPath = path.join(root, "artifact.zip");
    await writeFile(zipPath, buildArchive());

    const result = runScan(["--source", root, "--zip", zipPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/^artifact\.zip!\/(?:\.|#entry-\d+) SECRET_SCAN_ERROR\n$/u);
    expect(result.stdout).toBe("");
  });

  it.each([
    ["LF", "\n"],
    ["CR", "\r"],
    ["ESC", "\u001b"],
    ["C0 unit separator", "\u001f"],
    ["DEL", "\u007f"],
    ["C1 next line", "\u0085"],
    ["Unicode bidi format", "\u202e"],
    ["Unicode line separator", "\u2028"],
    ["Unicode paragraph separator", "\u2029"],
  ])("rejects a zip entry name containing %s without echoing untrusted diagnostics", async (_label, character) => {
    const root = await emptyRoot();
    const zipPath = path.join(root, "artifact.zip");
    const entryName = `iwind-aifin-connector/name-canary${character}tail.md`;
    const secret = `Bearer ${"C0n7r0l9".repeat(5)}`;
    await writeFile(zipPath, zipSync({ [entryName]: strToU8(secret) }));

    const result = runScan(["--source", root, "--zip", zipPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("artifact.zip!/#entry-1 SECRET_SCAN_ERROR\n");
    expect(result.stdout).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain("name-canary");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("continues to scan ordinary UTF-8 zip entry names", async () => {
    const root = await emptyRoot();
    const zipPath = path.join(root, "artifact.zip");
    await writeFile(zipPath, zipSync({ "iwind-aifin-connector/财务公告.md": strToU8("Clean instructions.\n") }));

    const result = runScan(["--source", root, "--zip", zipPath]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toBe("SECRET_SCAN_OK files=1 zip_entries=1\n");
  });

  it("still scans the default archive when source is explicitly set to dot", async () => {
    const root = await emptyRoot();
    const dist = path.join(root, "dist");
    const zipPath = path.join(dist, "iwind-aifin-connector-skill.zip");
    const secret = `Bearer ${"R3l4E5a6".repeat(5)}`;
    await mkdir(dist);
    await writeFile(zipPath, zipSync({ "iwind-aifin-connector/canary.md": strToU8(secret) }));

    const result = runScan(["--source", "."], root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "dist/iwind-aifin-connector-skill.zip!/iwind-aifin-connector/canary.md SECRET_BEARER",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("uses caller-supplied env values for exact matching without emitting the value", async () => {
    const root = await emptyRoot();
    const secretsFile = path.join(await emptyRoot(), "iwind.keys.env");
    const secret = ["exact", "fixture", "value", "0123456789abcdef"].join("-");
    await writeFile(secretsFile, `WIND_API_KEY_01=${secret}\n`);
    await writeFile(path.join(root, "leak.txt"), `prefix:${secret}:suffix`);
    const zipPath = await cleanZip(root);

    const result = runScan(["--source", root, "--zip", zipPath, "--secrets-file", secretsFile]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("leak.txt SECRET_EXACT_VALUE");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it.each([
    ["unquoted inline comment", "actual-value", "WIND_API_KEY_01=actual-value # operator note\n"],
    ["quoted literal comment and equals", "quoted=value # literal", 'WIND_API_KEY_01="quoted=value # literal"\n'],
    ["unquoted embedded equals", "left=right-value", "WIND_API_KEY_01=left=right-value\n"],
  ])("matches the exact Node env value for %s syntax", async (_syntax, secret, envSource) => {
    const root = await emptyRoot();
    const secretsFile = path.join(await emptyRoot(), "iwind.keys.env");
    const zipPath = await cleanZip(root);
    await writeFile(secretsFile, envSource);
    await writeFile(path.join(root, "leak.txt"), `prefix:${secret}:suffix`);

    const result = runScan(["--source", root, "--zip", zipPath, "--secrets-file", secretsFile]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("leak.txt SECRET_EXACT_VALUE");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it.each([
    ["empty file", ""],
    ["comment-only file", "# operator note\n"],
    ["empty value set", "WIND_API_KEY_01=\n"],
    ["partially unparsed input", "WIND_API_KEY_01=valid-value\nthis is not an env assignment\n"],
  ])("fails closed for a %s secrets file", async (_label, envSource) => {
    const root = await emptyRoot();
    const secretsFile = path.join(await emptyRoot(), "iwind.keys.env");
    const zipPath = await cleanZip(root);
    await writeFile(secretsFile, envSource);

    const result = runScan(["--source", root, "--zip", zipPath, "--secrets-file", secretsFile]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe(". SECRET_SCAN_ERROR\n");
  });

  it("fails closed when a non-comment secrets-file line is not an env assignment", async () => {
    const root = await emptyRoot();
    const secretsFile = path.join(await emptyRoot(), "iwind.keys.env");
    await writeFile(secretsFile, "this is not an env assignment\n");
    const zipPath = await cleanZip(root);

    const result = runScan(["--source", root, "--zip", zipPath, "--secrets-file", secretsFile]);
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
    const zipPath = await cleanZip(root);
    await writeFile(path.join(root, "README.md"), "Public connector instructions.\n");

    const result = runScan(["--source", root, "--zip", zipPath]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toMatch(/SECRET_SCAN_OK/u);
  });
});
