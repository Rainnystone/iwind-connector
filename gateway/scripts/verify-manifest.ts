import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";

import { UPSTREAMS } from "../src/config/upstreams";
import type { ToolManifestV1 } from "../src/contracts/load-manifest";
import { SOURCE_COMMIT, TOOL_SEED } from "../src/contracts/tool-seed";

const manifestUrl = new URL("../src/contracts/tool-manifest.json", import.meta.url);
const schemaUrl = new URL("../src/contracts/tool-manifest.schema.json", import.meta.url);
const hashUrl = new URL("../src/contracts/tool-manifest.sha256", import.meta.url);

try {
  const [manifestBytes, schemaBytes, hashBytes] = await Promise.all([
    readFile(manifestUrl),
    readFile(schemaUrl, "utf8"),
    readFile(hashUrl, "utf8"),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as ToolManifestV1;
  const schema: unknown = JSON.parse(schemaBytes);
  const validate = new Ajv2020({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
  if (!validate(manifest)) throw new Error("schema-validation-failed");

  const actualHash = createHash("sha256").update(manifestBytes).digest("hex");
  if (actualHash !== hashBytes.trim()) throw new Error("sha256-mismatch");
  if (manifest.sourceCommit !== SOURCE_COMMIT) throw new Error("source-commit-mismatch");
  if (manifest.upstreams.length !== 6) throw new Error("upstream-count-mismatch");

  const ids = Object.keys(UPSTREAMS) as UpstreamId[];
  const names: string[] = [];
  for (const [index, id] of ids.entries()) {
    const upstream = manifest.upstreams[index];
    if (!upstream || upstream.id !== id || upstream.url !== UPSTREAMS[id].url.href) {
      throw new Error("upstream-order-or-url-mismatch");
    }
    const expectedNames = [...TOOL_SEED[id]].sort();
    const actualNames = upstream.tools.map(({ name }) => name);
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error("tool-seed-mismatch");
    }
    names.push(...actualNames);
  }
  if (names.length !== 31 || new Set(names).size !== 31) throw new Error("tool-uniqueness-mismatch");
  process.stdout.write("PASS manifest schema/hash/seed: 6 upstreams, 31 unique tools\n");
} catch {
  process.stderr.write("FAIL manifest verification\n");
  process.exitCode = 1;
}

type UpstreamId = keyof typeof UPSTREAMS;
