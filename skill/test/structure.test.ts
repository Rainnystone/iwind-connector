import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SKILL_ROOT = path.resolve(import.meta.dirname, "..");
const SKILL_PATH = path.join(SKILL_ROOT, "SKILL.md");
const REFERENCES = [
  "stock.md",
  "fund.md",
  "index.md",
  "economic.md",
  "financial-docs.md",
  "analytics.md",
] as const;

function parseFrontmatter(source: string): Readonly<Record<string, string>> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  expect(match, "SKILL.md must begin with YAML frontmatter").not.toBeNull();
  const entries = (match?.[1] ?? "").split("\n").map((line) => {
    const separator = line.indexOf(":");
    expect(separator, `invalid frontmatter line: ${line}`).toBeGreaterThan(0);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
  });
  return Object.fromEntries(entries);
}

async function readInstructionTree(): Promise<ReadonlyArray<readonly [string, string]>> {
  return Promise.all([
    readFile(SKILL_PATH, "utf8").then((source) => ["SKILL.md", source] as const),
    ...REFERENCES.map((name) =>
      readFile(path.join(SKILL_ROOT, "references", name), "utf8").then(
        (source) => [`references/${name}`, source] as const,
      ),
    ),
  ]);
}

describe("runtime-neutral Skill structure", () => {
  it("uses exactly the model-facing name and six-branch trigger description", async () => {
    const frontmatter = parseFrontmatter(await readFile(SKILL_PATH, "utf8"));

    expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
    expect(frontmatter.name).toBe("iwind-aifin-connector");
    expect(frontmatter.description).toMatch(/^Use when\b/);
    expect(frontmatter.description).toMatch(/stock/i);
    expect(frontmatter.description).toMatch(/fund/i);
    expect(frontmatter.description).toMatch(/index/i);
    expect(frontmatter.description).toMatch(/macro|industry|foreign.exchange/i);
    expect(frontmatter.description).toMatch(/announcement|news/i);
    expect(frontmatter.description).toMatch(/financial calculation/i);
    expect(frontmatter.description).not.toMatch(/read|reference|serial|notice|workflow/i);
  });

  it("reaches each domain reference through one conditional pointer", async () => {
    const source = await readFile(SKILL_PATH, "utf8");

    for (const reference of REFERENCES) {
      const pointer = `references/${reference}`;
      expect(source.split(pointer)).toHaveLength(2);
      expect(source).toMatch(
        new RegExp(`(?:For|When|If)[^\\n]+\\[${reference.replace(".md", "")}\\]\\(${pointer.replace(".", "\\.")}\\)`, "i"),
      );
      await expect(readFile(path.join(SKILL_ROOT, "references", reference), "utf8")).resolves.not.toHaveLength(0);
    }
  });

  it("keeps the instruction tree neutral, non-executable, and schema-free", async () => {
    const tree = await readInstructionTree();
    const joined = tree.map(([name, source]) => `${name}\n${source}`).join("\n");
    const rootEntries = await readdir(SKILL_ROOT, { withFileTypes: true });

    expect(rootEntries.map((entry) => entry.name).sort()).toEqual([
      "SKILL.md",
      "evals",
      "references",
      "test",
    ]);
    expect(joined).not.toMatch(/https?:\/\//i);
    expect(joined).not.toMatch(/WIND_API_KEY_\d+|\.secrets(?:\/|\b)|mcp\.wind|\/vserver_/i);
    expect(joined).not.toMatch(/(?:^|\/)agents\/|openai\.yaml|\.claude\/|\.codex\//i);
    expect(joined).not.toMatch(/```(?:bash|sh|python|javascript|typescript|json)/i);
    expect(joined).not.toMatch(/inputSchema|\"properties\"\s*:|\"required\"\s*:|\$schema/i);
  });

  it("gives a checkable shared sequence and an explicit scope gate", async () => {
    const source = await readFile(SKILL_PATH, "utf8");

    expect(source).toMatch(/entity|market/i);
    expect(source).toMatch(/relative[^\n]+exact date/i);
    expect(source).toMatch(/least sufficient/i);
    expect(source).toMatch(/one at a time|one tool call[^\n]+completes/i);
    expect(source).toMatch(/date[^\n]+unit[^\n]+magnitude[^\n]+null[^\n]+row count[^\n]+(?:truncation|completeness)[^\n]+coverage/i);
    expect(source).toContain("IWIND_OPS_NOTICE_V1");
    expect(source).toMatch(/data first/i);
    expect(source).toMatch(/normal success[^\n]+no operations sentence/i);
    expect(source).toMatch(/trading|write action/i);
    expect(source).toMatch(/crypto/i);
    expect(source).toMatch(/Taiwan[^\n]+Japan[^\n]+Korea[^\n]+Europe/i);
    expect(source).toMatch(/futures order book/i);
    expect(source).toMatch(/service[^\n]+manifest/i);
    expect(source).toMatch(/out of scope[^\n]+(?:Web Search|analytics)/i);
  });

  it("keeps the entrypoint and disclosed references concise", async () => {
    const tree = await readInstructionTree();
    const [entrypoint, ...references] = tree;

    expect(entrypoint?.[1].trim().split("\n").length).toBeLessThanOrEqual(90);
    for (const [name, source] of references) {
      expect(source.trim().split("\n").length, name).toBeLessThanOrEqual(90);
      expect(source.length, name).toBeLessThanOrEqual(7_500);
    }
  });
});
