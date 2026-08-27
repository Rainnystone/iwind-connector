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
    expect(sources[0]).toMatch(/not[^\n]+tested[^\n]+ChatGPT Work account/iu);
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

  it("ships a reusable, secret-free acceptance checklist with every Task 12 gate", async () => {
    const checklist = await readFile(path.join(ROOT, "docs", "acceptance-checklist.md"), "utf8");

    for (const heading of [
      "Clean-room package",
      "Protocol client",
      "Fresh local Agent",
      "Adapter neutrality",
      "Staging rotation and restore",
      "Timeout and retry contract",
      "Production cutover",
      "Production security",
      "Final full gate",
      "Unverified external boundaries",
    ]) {
      expect(checklist).toContain(`## ${heading}`);
    }
    expect(checklist).not.toMatch(/ak_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9._~-]{12,}|@[^\s]+\.[A-Za-z]{2,}/u);
    expect(checklist).toMatch(/ChatGPT Work[^\n]+not tested/iu);
    expect(checklist).toMatch(/Grok Web[^\n]+not tested/iu);
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
