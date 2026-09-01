import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const ADAPTERS = ["chatgpt-work", "grok-web", "local"] as const;

describe("runtime-neutral release acceptance contract", () => {
  it("keeps all adapters on one Skill archive and one OAuth MCP endpoint concept", async () => {
    const sources = await Promise.all(
      ADAPTERS.map((adapter) => readFile(path.join(ROOT, "adapters", adapter, "README.md"), "utf8")),
    );

    for (const source of sources) {
      expect(source).toContain("dist/iwind-aifin-connector-skill.zip");
      expect(source).toContain("{PUBLIC_ORIGIN}/mcp");
      expect(source).not.toMatch(/WIND_API_KEY_|mcp\.wind|\/vserver_/iu);
    }
    expect(sources[0]).toMatch(/personal Pro[^\n]+verified/iu);
    expect(sources[0]).toMatch(/Skill upload[^\n]+not yet verified/iu);
    expect(sources[1]).toMatch(/not[^\n]+tested[^\n]+Grok Web account/iu);
  });

  it("keeps platform branches and private metadata out of the core Skill and gateway", async () => {
    const coreFiles = [
      path.join(ROOT, "skill", "SKILL.md"),
      ...(await recursiveFiles(path.join(ROOT, "skill", "references"))),
      ...(await recursiveFiles(path.join(ROOT, "skill", "evals"))),
      ...(await recursiveFiles(path.join(ROOT, "gateway", "src"))).filter(
        (file) => !file.endsWith("worker-configuration.d.ts"),
      ),
    ];
    const core = (await Promise.all(coreFiles.map((file) => readFile(file, "utf8")))).join("\n");

    expect(core).not.toMatch(/\b(?:ChatGPT|Grok)\b|openai\.yaml|agents\/openai/iu);
  });

  it("ships a reusable, secret-free acceptance checklist with historical and ring-release gates", async () => {
    const checklist = await readFile(path.join(ROOT, "docs", "acceptance-checklist.md"), "utf8");

    for (const heading of [
      "Clean-room package",
      "Protocol client",
      "Fresh local Agent",
      "Adapter neutrality",
      "Prior-release staging rotation evidence",
      "v0.4 persistent ring local gate",
      "v0.4 future staging rollout",
      "Timeout and retry contract",
      "Production cutover",
      "Production security",
      "Final full gate",
      "ChatGPT Work cloud follow-up",
      "Unverified external boundaries",
    ]) {
      expect(checklist).toContain(`## ${heading}`);
    }
    expect(checklist).not.toMatch(/ak_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9._~-]{12,}|@[^\s]+\.[A-Za-z]{2,}/u);
    expect(checklist).toMatch(/ChatGPT Work[^\n]+Plugin[^\n]+verified/iu);
    expect(checklist).toMatch(/Skill upload[^\n]+not yet verified/iu);
    expect(checklist).toMatch(/Grok Web[^\n]+not tested/iu);
  });

  it("keeps deployment documentation on complete-secret candidate versions", async () => {
    const [installation, security, operations, troubleshooting, checklist, readme] = await Promise.all([
      readFile(path.join(ROOT, "docs", "installation.md"), "utf8"),
      readFile(path.join(ROOT, "docs", "security.md"), "utf8"),
      readFile(path.join(ROOT, "docs", "operations.md"), "utf8"),
      readFile(path.join(ROOT, "docs", "troubleshooting.md"), "utf8"),
      readFile(path.join(ROOT, "docs", "acceptance-checklist.md"), "utf8"),
      readFile(path.join(ROOT, "README.md"), "utf8"),
    ]);

    const existingUpload = `npx --no-install wrangler versions upload \\
     --config dist/wrangler.deploy.jsonc \\
     --secrets-file ../.secrets/iwind.cloudflare.env`;
    const candidateInspection = `npx --no-install wrangler versions view <candidate> \\
     --config dist/wrangler.deploy.jsonc \\
     --json`;
    const exactDeploy = `npx --no-install wrangler versions deploy <candidate>@100% \\
     --config dist/wrangler.deploy.jsonc`;
    const firstCreate = `npx --no-install wrangler deploy \\
     --config dist/wrangler.deploy.jsonc \\
     --secrets-file ../.secrets/iwind.cloudflare.env`;

    expect(installation).toContain(existingUpload);
    expect(installation).toContain(candidateInspection);
    expect(installation).toContain(exactDeploy);
    expect(installation).toContain(firstCreate);
    expect(operations).toContain("versions view <candidate> --config dist/wrangler.deploy.jsonc --json");
    expect(operations).toContain(exactDeploy);
    expect(security).toContain("--config dist/wrangler.deploy.jsonc");
    expect(troubleshooting).toContain("versions view <candidate>");
    expect(checklist).toContain("versions view <candidate>");
    expect(checklist).toContain("wrangler deploy --config dist/wrangler.deploy.jsonc --secrets-file");
    expect(readme).toContain("versions view <candidate>");
    expect(installation).toContain("no percentage split");
    expect(checklist).toContain("do not percentage-split");
    expect(security).toMatch(/secret put[^\n]+immediately deploy/iu);
    expect(operations).toContain("persisted manifest is the runtime authority");
    expect(operations).toContain("expand candidate can read the persisted successor layout");
    expect(checklist).not.toContain("wrangler secret put NAME_FROM_REQUIRED_LIST");
    expect(operations).not.toContain("wrangler secret put WIND_API_KEY_");
  });
});

async function recursiveFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await recursiveFiles(target)));
    else if (entry.isFile() && /\.(?:ts|json|md)$/u.test(entry.name)) files.push(target);
  }
  return files.sort();
}
