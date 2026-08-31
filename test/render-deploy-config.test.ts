import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KEY_SLOT_DEFINITIONS } from "../gateway/src/key-pool/slots";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "render-deploy-config.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SOURCE = path.join(REPO_ROOT, "gateway", "wrangler.jsonc");
const OUTPUT = path.join(REPO_ROOT, "dist", "wrangler.deploy.jsonc");
const LEGACY_TEMP = `${OUTPUT}.tmp`;
const VALID_ARGS = [
  "--oauth-kv-id",
  "1234567890abcdef1234567890abcdef",
  "--worker-name",
  "iwind-connector-staging",
  "--public-origin",
  "https://iwind.example.invalid",
  "--deployment-stage",
  "staging",
] as const;

function runRender(args: ReadonlyArray<string>): Readonly<{ status: number | null; stdout: string; stderr: string }> {
  const result = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
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

describe("deploy config renderer", () => {
  beforeEach(async () => {
    await mkdir(path.dirname(OUTPUT), { recursive: true });
    await removePath(OUTPUT);
    await removePath(LEGACY_TEMP);
  });

  afterEach(async () => {
    await removePath(OUTPUT);
    await removePath(LEGACY_TEMP);
  });

  it("renders only the four approved non-Secret values to the ignored dist config", async () => {
    const sourceBefore = await readFile(SOURCE, "utf8");
    const result = runRender(VALID_ARGS);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toBe("DEPLOY_CONFIG_OK dist/wrangler.deploy.jsonc\n");

    const rendered = JSON.parse(await readFile(OUTPUT, "utf8")) as {
      name: string;
      main: string;
      vars: { PUBLIC_ORIGIN: string; DEPLOYMENT_STAGE: string };
      kv_namespaces: ReadonlyArray<{ binding: string; id: string }>;
      secrets: { required: ReadonlyArray<string> };
    };
    expect(rendered.name).toBe("iwind-connector-staging");
    expect(rendered.main).toBe("../gateway/src/index.ts");
    expect(rendered.vars).toEqual({
      PUBLIC_ORIGIN: "https://iwind.example.invalid",
      DEPLOYMENT_STAGE: "staging",
    });
    expect(rendered.kv_namespaces).toEqual([
      { binding: "OAUTH_KV", id: "1234567890abcdef1234567890abcdef" },
    ]);
    expect(rendered.secrets.required.filter((binding) => binding.startsWith("WIND_API_KEY_"))).toEqual(
      KEY_SLOT_DEFINITIONS.map(({ secretBinding }) => secretBinding),
    );
    await expect(readFile(SOURCE, "utf8")).resolves.toBe(sourceBefore);
  });

  it.each([
    ["all-zero KV sentinel", VALID_ARGS.with(1, "00000000000000000000000000000000")],
    ["unknown stage", VALID_ARGS.with(7, "preview")],
    ["non-HTTPS production origin", VALID_ARGS.with(5, "http://iwind.example.invalid").with(7, "production")],
    ["source writeback flag", [...VALID_ARGS, "--output", "gateway/wrangler.jsonc"]],
  ])("rejects %s and leaves the source config byte-identical", async (_label, args) => {
    const sourceBefore = await readFile(SOURCE, "utf8");
    const result = runRender(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("DEPLOY_CONFIG_INVALID\n");
    await expect(readFile(SOURCE, "utf8")).resolves.toBe(sourceBefore);
  });

  it("does not follow a pre-seeded predictable temp symlink into protected bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "iwind-render-test-"));
    const protectedPath = path.join(root, "protected.jsonc");
    await writeFile(protectedPath, "protected source bytes\n");
    const protectedBefore = await readFile(protectedPath);
    await symlink(protectedPath, LEGACY_TEMP);

    const result = runRender(VALID_ARGS);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    await expect(readFile(protectedPath)).resolves.toEqual(protectedBefore);
    expect((await lstat(LEGACY_TEMP)).isSymbolicLink()).toBe(true);
  });

  it.each(["symlink", "directory"])("rejects a final output %s conflict safely", async (kind) => {
    const sourceBefore = await readFile(SOURCE);
    if (kind === "symlink") await symlink(SOURCE, OUTPUT);
    else await mkdir(OUTPUT);

    const result = runRender(VALID_ARGS);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("DEPLOY_CONFIG_INVALID\n");
    await expect(readFile(SOURCE)).resolves.toEqual(sourceBefore);
    expect((await readdir(path.dirname(OUTPUT))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("atomically replaces a normal fixed output without leaving temp files", async () => {
    await writeFile(OUTPUT, "stale generated config\n");
    const result = runRender(VALID_ARGS);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(await readFile(OUTPUT, "utf8"))).toMatchObject({ name: "iwind-connector-staging" });
    expect((await readdir(path.dirname(OUTPUT))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
