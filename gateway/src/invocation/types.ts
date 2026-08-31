import type { CallToolResult } from "@modelcontextprotocol/client";

import type { UpstreamDefinition, UpstreamId } from "../config/upstreams";
import type { AcquireLeaseResult, ReportOutcomeInput, SlotId } from "../key-pool/types";
import type { WindSecretBindingName } from "../key-pool/slots";
import type { GatewayLogEvent } from "../logging/event";
import type { OpsNoticeV1 } from "../notices/types";

export interface InvocationRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface InvocationResult {
  readonly toolResult: CallToolResult;
  readonly notice: OpsNoticeV1 | null;
}

export interface WindToolCaller {
  call(input: {
    upstream: UpstreamDefinition;
    toolName: string;
    arguments: Readonly<Record<string, unknown>>;
    apiKey: string;
    timeoutMs: 600_000;
    maxResponseBytes: 8_388_608;
  }): Promise<CallToolResult>;
}

export interface InvocationKeyPool {
  acquire(
    requestId: string,
    attemptedSlotIds: readonly SlotId[],
  ): Promise<AcquireLeaseResult>;
  report(input: ReportOutcomeInput): Promise<void>;
  consumeTestOutcome?(slotId: SlotId): Promise<Exclude<ReportOutcomeInput["category"], "success"> | null>;
}

export type InvocationEnvironment = Pick<Cloudflare.Env, "KEY_POOL"> & {
  readonly [Binding in WindSecretBindingName]: string | undefined;
} & {
  readonly DEPLOYMENT_STAGE?: string;
};

export interface InvocationDependencies {
  readonly env: InvocationEnvironment;
  readonly waitUntil: (promise: Promise<void>) => void;
  readonly keyPool?: InvocationKeyPool;
  readonly caller?: WindToolCaller;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly log?: (event: GatewayLogEvent) => void;
}

export interface HeldLease {
  readonly leaseId: string;
  readonly slotId: SlotId;
}

export interface ToolRoute {
  readonly upstream: UpstreamDefinition;
  readonly domain: UpstreamId;
}
