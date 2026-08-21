import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { UPSTREAMS } from "../../src/config/upstreams";
import { loadManifest } from "../../src/contracts/load-manifest";
import { TOOL_SEED } from "../../src/contracts/tool-seed";
import probeFixture from "../fixtures/probe-success.json";

const manifestPath = new URL("../../src/contracts/tool-manifest.json", import.meta.url);
const schemaPath = new URL("../../src/contracts/tool-manifest.schema.json", import.meta.url);
const hashPath = new URL("../../src/contracts/tool-manifest.sha256", import.meta.url);

describe("frozen Wind tool manifest", () => {
  it("matches the six upstream registry entries and frozen 30-name seed", () => {
    const manifest = loadManifest();
    const expectedIds = Object.keys(UPSTREAMS);
    const expectedNames = probeFixture.upstreams.flatMap(({ toolNames }) => toolNames);
    const actualNames = manifest.upstreams.flatMap(({ tools }) => tools.map(({ name }) => name));

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.sourceCommit).toBe(probeFixture.sourceCommit);
    expect(manifest.upstreams.map(({ id }) => id)).toEqual(expectedIds);
    expect(manifest.upstreams.map(({ url }) => url)).toEqual(
      Object.values(UPSTREAMS).map(({ url }) => url.href),
    );
    expect(Object.values(TOOL_SEED).flat()).toEqual(expectedNames);
    expect(actualNames).toHaveLength(31);
    expect(new Set(actualNames).size).toBe(31);
    expect(actualNames.toSorted()).toEqual(expectedNames.toSorted());
  });

  it("contains one owner, a description, and an object JSON Schema for every tool", () => {
    const manifest = loadManifest();
    const owners = new Map<string, string>();

    for (const upstream of manifest.upstreams) {
      expect(upstream.transport).toBe("streamable-http");
      expect(upstream.tools).toHaveLength(UPSTREAMS[upstream.id].expectedToolCount);
      for (const tool of upstream.tools) {
        expect(tool.description.trim().length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe("object");
        expect(owners.has(tool.name)).toBe(false);
        owners.set(tool.name, upstream.id);
      }
    }

    expect(owners.size).toBe(31);
  });

  it("validates against its JSON Schema and matches its SHA-256 sidecar", async () => {
    const [manifestBytes, schemaBytes, expectedHash] = await Promise.all([
      readFile(manifestPath),
      readFile(schemaPath, "utf8"),
      readFile(hashPath, "utf8"),
    ]);
    const schema: unknown = JSON.parse(schemaBytes);
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    const validate = new Ajv2020({ allErrors: true, strict: true, validateFormats: false }).compile(
      schema,
    );

    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(expectedHash.trim());
  });
});
