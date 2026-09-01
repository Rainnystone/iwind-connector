import { authenticateAdmin } from "./authenticate";
import { getKeyPoolConfiguration, isSlotIdInLayout } from "../key-pool/slots";
import type { SlotId } from "../key-pool/types";
import { hasExactKeys, parseTestControl } from "./test-control";

const TEST_CONTROL_PATH = "/admin/test-controls/next-outcome";
const MAX_ADMIN_BODY_BYTES = 4096;

type AdminEnvironment = Pick<Cloudflare.Env, "ADMIN_TOKEN" | "KEY_POOL" | "KEY_POOL_LAYOUT_ID"> & {
  readonly DEPLOYMENT_STAGE: "local" | "staging" | "production";
};

export async function handleAdminRequest(
  request: Request,
  env: AdminEnvironment,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/")) return notFound();
  if (url.pathname.startsWith("/admin/test-controls/") && env.DEPLOYMENT_STAGE !== "staging") {
    return notFound();
  }

  const configuration = getKeyPoolConfiguration(env.KEY_POOL_LAYOUT_ID);
  const route = matchRoute(url.pathname, configuration.layout.layoutId);
  if (route === null) return notFound();
  if (request.method !== route.method) {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: route.method } });
  }
  const authentication = await authenticateAdmin(
    request.headers.get("authorization"),
    env.ADMIN_TOKEN,
  );
  if (authentication === "missing_or_malformed") {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="iWind admin"' },
    });
  }
  if (authentication === "rejected") return new Response("Forbidden", { status: 403 });

  const keyPool = env.KEY_POOL.getByName(configuration.generation.objectName);
  if (route.kind === "status") {
    const status = await keyPool.getStatus();
    return Response.json(
      {
        currentSlotId: status.currentSlotId,
        slots: status.slots.map((slot) => ({
          slotId: slot.slotId,
          priority: slot.priority,
          state: slot.state,
          resetAt: slot.resetAt,
          cooldownUntil: slot.cooldownUntil,
          callCount: slot.callCount,
          updatedAt: slot.updatedAt,
        })),
        lease:
          status.lease === null
            ? null
            : { active: true, slotId: status.lease.slotId, expiresAt: status.lease.expiresAt },
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const body = await readExactJsonBody(request);
  if (body.kind === "unsupported") return new Response("Unsupported Media Type", { status: 415 });
  if (body.kind === "invalid") return new Response("Bad Request", { status: 400 });

  if (route.kind === "slot") {
    if (!hasExactKeys(body.value, [])) return new Response("Bad Request", { status: 400 });
    if (route.action === "restore") await keyPool.restoreSlot(route.slotId, now);
    else await keyPool.disableSlot(route.slotId, now);
    return new Response(null, { status: 204 });
  }

  const outcome = parseTestControl(body.value, configuration.layout.layoutId);
  if (outcome === null) return new Response("Bad Request", { status: 400 });
  await keyPool.setNextTestOutcome(outcome);
  return new Response(null, { status: 204 });
}

type AdminRoute =
  | { readonly kind: "status"; readonly method: "GET" }
  | {
      readonly kind: "slot";
      readonly method: "POST";
      readonly slotId: SlotId;
      readonly action: "restore" | "disable";
    }
  | { readonly kind: "test-control"; readonly method: "POST" };

function matchRoute(pathname: string, layoutId: string): AdminRoute | null {
  if (pathname === "/admin/key-pool") return { kind: "status", method: "GET" };
  if (pathname === TEST_CONTROL_PATH) return { kind: "test-control", method: "POST" };
  const match = pathname.match(/^\/admin\/key-pool\/slots\/([^/]+)\/(restore|disable)$/u);
  if (
    match === null ||
    !isSlotIdInLayout(match[1], layoutId) ||
    (match[2] !== "restore" && match[2] !== "disable")
  ) {
    return null;
  }
  return { kind: "slot", method: "POST", slotId: match[1], action: match[2] };
}

async function readExactJsonBody(
  request: Request,
): Promise<
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
  | { readonly kind: "unsupported" }
  | { readonly kind: "invalid" }
> {
  if (request.headers.get("content-type") !== "application/json") return { kind: "unsupported" };
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_ADMIN_BODY_BYTES) return { kind: "invalid" };
  const text = await readBoundedText(request, MAX_ADMIN_BODY_BYTES);
  if (text === null) return { kind: "invalid" };
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { kind: "ok", value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

async function readBoundedText(request: Request, maximum: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
