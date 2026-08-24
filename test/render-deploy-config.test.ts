import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "render-deploy-config.ts");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SOURCE = path.join(REPO_ROOT, "gateway", "wrangler.jsonc");
const OUTPUT = path.join(REPO_ROOT, "dist", "wrangler.deploy.jsonc");
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

describe("deploy config renderer", () => {
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
    expect(rendered.secrets.required).toContain("WIND_API_KEY_01");
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
});
