import type { CallToolResult } from "@modelcontextprotocol/client";

import { getUpstream } from "../config/upstreams";
import { loadManifest } from "../contracts/load-manifest";
import { classifyWindFailure } from "../errors/classifier";
import type { ClassifiedFailure, WindFailureCategory } from "../errors/types";
import { acquireKeyPoolLease } from "../key-pool/client";
import type { AcquireLeaseResult, ReportOutcomeInput, SlotId } from "../key-pool/types";
import { emitLogEvent, type GatewayLogEvent } from "../logging/event";
import type { OpsNoticeV1 } from "../notices/types";
import { createWindToolCaller, WindCallFailure } from "../upstream/call-tool";

import { MissingWindSecretError, resolveWindSecret } from "./resolve-secret";
import type {
  HeldLease,
  InvocationDependencies,
  InvocationKeyPool,
  InvocationRequest,
  InvocationResult,
  ToolRoute,
} from "./types";

const TIMEOUT_MS = 600_000 as const;
const MAX_RESPONSE_BYTES = 8_388_608 as const;
const AUTH_FAILURE_BODY = JSON.stringify({ error: { code: "AUTH_ERROR" } });

export async function invokeWindTool(
  request: InvocationRequest,
  dependencies: InvocationDependencies,
): Promise<InvocationResult> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? wait;
  const keyPool = dependencies.keyPool ?? keyPoolFromEnvironment(dependencies.env);
  const log = dependencies.log ?? ((event: GatewayLogEvent) => emitLogEvent(event));
  const startedAt = now();
  const route = resolveToolRoute(request.toolName);

  if (route === null) {
    const notice = failureNotice(request.requestId, "WIND_REQUEST_FAILED", "unknown");
    safeLog(log, logEvent(request, "unknown", null, "WIND_UNKNOWN", startedAt, now(), null, notice));
    return { toolResult: failureToolResult("WIND_UNKNOWN"), notice };
  }

  let heldLease: HeldLease | null = null;
  let initialCategory: WindFailureCategory | null = null;
  let failoverStarted = false;
  let lastResponseBytes: number | null = null;
  const caller =
    dependencies.caller ??
    createWindToolCaller({
      onResponseBytes: (bytes) => {
        lastResponseBytes = bytes;
      },
    });
  const attemptedSlots = new Set<SlotId>();

  const settleLease = async (
    category: ReportOutcomeInput["category"],
    resetAt: number | null,
  ): Promise<boolean> => {
    const lease = heldLease;
    if (lease === null) return true;
    heldLease = null;
    try {
      await keyPool.report({
        leaseId: lease.leaseId,
        slotId: lease.slotId,
        category,
        resetAt,
        occurredAt: now(),
      });
      return true;
    } catch {
      safeLog(
        log,
        logEvent(
          request,
          route.domain,
          lease.slotId,
          "lease_repair_required",
          startedAt,
          now(),
          lastResponseBytes,
          null,
        ),
      );
      return false;
    }
  };

  try {
    while (true) {
      const acquisition = await keyPool.acquire(request.requestId);
      if (!acquisition.ok) {
        const notice = admissionNotice(
          request.requestId,
          acquisition,
          initialCategory,
          failoverStarted,
        );
        safeLog(
          log,
          logEvent(
            request,
            route.domain,
            null,
            acquisition.code,
            startedAt,
            now(),
            lastResponseBytes,
            notice,
          ),
        );
        return { toolResult: failureToolResult(acquisition.code), notice };
      }

      heldLease = { leaseId: acquisition.leaseId, slotId: acquisition.slotId };
      if (attemptedSlots.has(acquisition.slotId)) {
        initialCategory ??= "unknown";
        failoverStarted = true;
        const reported = await settleLease("unknown", null);
        return cleanupOrFailure(
          request,
          route,
          startedAt,
          now(),
          log,
          initialCategory,
          true,
          reported,
          lastResponseBytes,
          "WIND_REPEATED_SLOT",
        );
      }
      attemptedSlots.add(acquisition.slotId);

      let failure: ClassifiedFailure;
      try {
        const apiKey = resolveWindSecret(dependencies.env, acquisition.slotId);
        const outcome = await callOnLease(
          request,
          route,
          caller,
          apiKey,
          now,
          sleep,
          (bytes) => {
            lastResponseBytes = bytes;
          },
          async (toolResult) => {
            const reported = await settleLease("success", null);
            if (!reported) {
              const notice = failureNotice(
                request.requestId,
                failoverStarted ? "WIND_KEY_ROTATION_FAILED" : "WIND_REQUEST_FAILED",
                initialCategory ?? "unknown",
              );
              safeLog(
                log,
                logEvent(
                  request,
                  route.domain,
                  acquisition.slotId,
                  "KEY_POOL_REPORT_FAILED",
                  startedAt,
                  now(),
                  lastResponseBytes,
                  notice,
                ),
              );
              return {
                toolResult: failureToolResult("KEY_POOL_REPORT_FAILED"),
                notice,
              };
            }
            const notice = failoverStarted
              ? successNotice(request.requestId, initialCategory)
              : null;
            safeLog(
              log,
              logEvent(
                request,
                route.domain,
                acquisition.slotId,
                "success",
                startedAt,
                now(),
                lastResponseBytes,
                notice,
              ),
            );
            return { toolResult, notice };
          },
        );
        if (outcome.kind === "completed") return outcome.result;
        failure = outcome.failure;
      } catch (error) {
        failure =
          error instanceof MissingWindSecretError
            ? classifyWindFailure({ body: AUTH_FAILURE_BODY, now: now() })
            : classifyThrownFailure(error, now());
      }

      initialCategory ??= failure.category;
      if (failure.decision.kind === "failover_slot") {
        failoverStarted = true;
        const reported = await settleLease(failure.category, failure.resetAt);
        if (!reported) {
          return cleanupOrFailure(
            request,
            route,
            startedAt,
            now(),
            log,
            initialCategory,
            failoverStarted,
            false,
            lastResponseBytes,
            "KEY_POOL_REPORT_FAILED",
          );
        }
        continue;
      }

      const reported = await settleLease(
        failure.category,
        reportResetAt(failure, now()),
      );
      return cleanupOrFailure(
        request,
        route,
        startedAt,
        now(),
        log,
        initialCategory,
        failoverStarted,
        reported,
        lastResponseBytes,
        failure.stableCode,
      );
    }
  } catch {
    initialCategory ??= "unknown";
    const reported = await settleLease("unknown", null);
    return cleanupOrFailure(
      request,
      route,
      startedAt,
      now(),
      log,
      initialCategory,
      failoverStarted,
      reported,
      lastResponseBytes,
      "WIND_UNKNOWN",
    );
  } finally {
    if (heldLease !== null) await settleLease("unknown", null);
  }
}

type CallOnLeaseOutcome =
  | { readonly kind: "completed"; readonly result: InvocationResult }
  | { readonly kind: "failed"; readonly failure: ClassifiedFailure };

async function callOnLease(
  request: InvocationRequest,
  route: ToolRoute,
  caller: NonNullable<InvocationDependencies["caller"]>,
  apiKey: string,
  now: () => number,
  sleep: (delayMs: number) => Promise<void>,
  recordBytes: (bytes: number | null) => void,
  complete: (toolResult: CallToolResult) => Promise<InvocationResult>,
): Promise<CallOnLeaseOutcome> {
  let retried = false;
  while (true) {
    try {
      const toolResult = await caller.call({
        upstream: route.upstream,
        toolName: request.toolName,
        arguments: request.input,
        apiKey,
        timeoutMs: TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      const toolFailure = classifyToolErrorResult(toolResult, now());
      if (toolFailure === null) {
        const completedResult = await complete(toolResult);
        return { kind: "completed", result: completedResult };
      }
      if (toolFailure.decision.kind === "retry_same_slot" && !retried) {
        retried = true;
        await sleep(toolFailure.decision.delayMs);
        continue;
      }
      return { kind: "failed", failure: toolFailure };
    } catch (error) {
      const failure = classifyThrownFailure(error, now());
      if (error instanceof WindCallFailure) recordBytes(error.responseBytes);
      if (failure.decision.kind === "retry_same_slot" && !retried) {
        retried = true;
        await sleep(failure.decision.delayMs);
        continue;
      }
      return { kind: "failed", failure };
    }
  }
}

function classifyToolErrorResult(result: CallToolResult, now: number): ClassifiedFailure | null {
  if (result.isError !== true) return null;
  if (!isRecord(result.structuredContent) || !isRecord(result.structuredContent.error)) {
    return unknownFailure();
  }
  const error = result.structuredContent.error;
  if (typeof error.code !== "string") return unknownFailure();
  const projected = {
    error: {
      code: error.code,
      ...(typeof error.reset_at === "number" ? { reset_at: error.reset_at } : {}),
    },
  };
  return classifyWindFailure({ body: JSON.stringify(projected), now });
}

function classifyThrownFailure(error: unknown, now: number): ClassifiedFailure {
  if (!(error instanceof WindCallFailure)) return unknownFailure();
  if (error.forcedCategory === "response_too_large") {
    return {
      category: "response_too_large",
      stableCode: "WIND_RESPONSE_TOO_LARGE",
      decision: { kind: "stop" },
      resetAt: null,
    };
  }
  return classifyWindFailure({ ...error.classificationInput, now });
}

function resolveToolRoute(toolName: string): ToolRoute | null {
  let route: ToolRoute | null = null;
  for (const manifestUpstream of loadManifest().upstreams) {
    if (!manifestUpstream.tools.some((tool) => tool.name === toolName)) continue;
    if (route !== null) return null;
    route = {
      upstream: getUpstream(manifestUpstream.id),
      domain: manifestUpstream.id,
    };
  }
  return route;
}

function keyPoolFromEnvironment(
  env: InvocationDependencies["env"],
): InvocationKeyPool {
  const stub = env.KEY_POOL.getByName("private-key-pool");
  return {
    acquire: (requestId) => acquireKeyPoolLease(env, requestId),
    report: (input) => stub.reportOutcome(input),
  };
}

function cleanupOrFailure(
  request: InvocationRequest,
  route: ToolRoute,
  startedAt: number,
  finishedAt: number,
  log: (event: GatewayLogEvent) => void,
  initialCategory: WindFailureCategory,
  failoverStarted: boolean,
  reportSucceeded: boolean,
  responseBytes: number | null,
  stableCode: string,
): InvocationResult {
  const effectiveCode = reportSucceeded ? stableCode : "KEY_POOL_REPORT_FAILED";
  const notice = failureNotice(
    request.requestId,
    failoverStarted ? "WIND_KEY_ROTATION_FAILED" : "WIND_REQUEST_FAILED",
    initialCategory,
  );
  safeLog(
    log,
    logEvent(
      request,
      route.domain,
      null,
      effectiveCode,
      startedAt,
      finishedAt,
      responseBytes,
      notice,
    ),
  );
  return { toolResult: failureToolResult(effectiveCode), notice };
}

function admissionNotice(
  requestId: string,
  acquisition: Extract<AcquireLeaseResult, { readonly ok: false }>,
  initialCategory: WindFailureCategory | null,
  failoverStarted: boolean,
): OpsNoticeV1 {
  if (failoverStarted) {
    return failureNotice(requestId, "WIND_KEY_ROTATION_FAILED", initialCategory ?? "unknown");
  }
  return failureNotice(requestId, acquisition.code, initialCategory);
}

function successNotice(
  requestId: string,
  initialCategory: WindFailureCategory | null,
): OpsNoticeV1 {
  return {
    schemaVersion: 1,
    code: "WIND_KEY_ROTATED",
    initialCategory,
    finalStatus: "succeeded",
    requestId,
  };
}

function failureNotice(
  requestId: string,
  code: Exclude<OpsNoticeV1["code"], "WIND_KEY_ROTATED">,
  initialCategory: WindFailureCategory | null,
): OpsNoticeV1 {
  return { schemaVersion: 1, code, initialCategory, finalStatus: "failed", requestId };
}

function failureToolResult(code: string): CallToolResult {
  return {
    content: [{ type: "text", text: `iWind request failed (${code}).` }],
    isError: true,
  };
}

function unknownFailure(): ClassifiedFailure {
  return {
    category: "unknown",
    stableCode: "WIND_UNKNOWN",
    decision: { kind: "stop" },
    resetAt: null,
  };
}

function reportResetAt(failure: ClassifiedFailure, now: number): number | null {
  if (failure.resetAt !== null) return failure.resetAt;
  return failure.category === "qps" && failure.decision.kind === "retry_same_slot"
    ? now + failure.decision.delayMs
    : null;
}

function logEvent(
  request: InvocationRequest,
  domain: GatewayLogEvent["domain"],
  slotId: SlotId | null,
  status: string,
  startedAt: number,
  finishedAt: number,
  responseBytes: number | null,
  notice: OpsNoticeV1 | null,
): GatewayLogEvent {
  return {
    requestId: request.requestId,
    domain,
    toolName: request.toolName,
    slotId,
    status,
    durationMs: Math.max(0, finishedAt - startedAt),
    responseBytes,
    noticeCode: notice?.code ?? null,
  };
}

function safeLog(log: (event: GatewayLogEvent) => void, event: GatewayLogEvent): void {
  try {
    log(event);
  } catch {
    // Observability must not change lease or request semantics.
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
