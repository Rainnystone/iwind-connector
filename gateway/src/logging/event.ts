import type { UpstreamId } from "../config/upstreams";
import type { SlotId } from "../key-pool/types";
import type { OpsNoticeV1 } from "../notices/types";

export interface GatewayLogEvent {
  readonly requestId: string;
  readonly domain: UpstreamId | "unknown";
  readonly toolName: string;
  readonly slotId: SlotId | null;
  readonly status: string;
  readonly durationMs: number;
  readonly responseBytes: number | null;
  readonly noticeCode: OpsNoticeV1["code"] | null;
}

export function emitLogEvent(
  event: GatewayLogEvent,
  sink: (serialized: string) => void = console.log,
): void {
  const allowlistedEvent: GatewayLogEvent = {
    requestId: event.requestId,
    domain: event.domain,
    toolName: event.toolName,
    slotId: event.slotId,
    status: event.status,
    durationMs: event.durationMs,
    responseBytes: event.responseBytes,
    noticeCode: event.noticeCode,
  };
  sink(JSON.stringify(allowlistedEvent));
}
