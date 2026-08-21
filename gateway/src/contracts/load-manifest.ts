import manifestJson from "./tool-manifest.json";

import type { UpstreamId } from "./domain";
import { SOURCE_COMMIT } from "./tool-seed";

export interface ManifestTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ManifestUpstream {
  readonly id: UpstreamId;
  readonly url: string;
  readonly transport: "streamable-http";
  readonly serverInfo: Readonly<Record<string, unknown>>;
  readonly tools: readonly ManifestTool[];
}

export interface ToolManifestV1 {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly sourceCommit: typeof SOURCE_COMMIT;
  readonly upstreams: readonly ManifestUpstream[];
}

export function loadManifest(): ToolManifestV1 {
  return manifestJson as ToolManifestV1;
}
