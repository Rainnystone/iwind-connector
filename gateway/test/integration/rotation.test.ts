import type { CallToolResult } from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { handleAdminRequest } from "../../src/admin/handler";
import type { WindFailureCategory } from "../../src/errors/types";
import { invokeWindTool } from "../../src/invocation/invoke";
import type { WindToolCaller } from "../../src/invocation/types";
import { WindCallFailure } from "../../src/upstream/call-tool";

const ADMIN_TOKEN = "task-10-independent-admin";
const KEY_01 = "task-10-key-one";
const KEY_02 = "task-10-key-two";
const REQUEST = {
  requestId: "task-10-rotation",
  toolName: "get_stock_price_indicators",
  input: { windcode: "600519.SH" },
} as const;
const SUCCESS: CallToolResult = {
  content: [{ type: "text", text: "synthetic-success" }],
  isError: false,
};

afterEach(async () => {
  await reset();
});

describe("local KeyPool integration", () => {
  it("rotates consecutive canonical daily outcomes as key-01 to key-02 to key-01", async () => {
    await setNextOutcome("key-01", "daily_quota");
    const caller = trackedCaller([SUCCESS]);

    const rotated = await invokeWindTool(REQUEST, dependencies(caller));

    expect(rotated.toolResult).toBe(SUCCESS);
    expect(rotated.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "daily_quota",
      finalStatus: "succeeded",
    });
    expect(caller.slots).toEqual(["key-02"]);
    expect(caller.maxInFlight).toBe(1);
    expect(await currentSlotId()).toBe("key-02");

    await setNextOutcome("key-02", "daily_quota");
    const wrappedCaller = trackedCaller([SUCCESS]);
    const wrapped = await invokeWindTool(
      { ...REQUEST, requestId: "task-10-wrapped" },
      dependencies(wrappedCaller),
    );

    expect(wrapped.toolResult).toBe(SUCCESS);
    expect(wrapped.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "daily_quota",
      finalStatus: "succeeded",
    });
    expect(wrappedCaller.slots).toEqual(["key-01"]);
    expect(wrappedCaller.maxInFlight).toBe(1);
    expect(await currentSlotId()).toBe("key-01");
  });

  it.each([
    ["qps", qpsFailure()],
    ["concurrency", structuredFailure("CONCURRENCY_LIMIT_ERROR")],
    ["network", new WindCallFailure({ error: new TypeError("synthetic network") })],
    ["upstream_5xx", new WindCallFailure({ status: 503 })],
    ["timeout", timeoutFailure()],
  ] as const)(
    "retries a synthetic %s outcome at most once on key-01 and never selects key-02",
    async (category, terminalFailure) => {
      await setNextOutcome("key-01", category);
      const caller = trackedCaller([terminalFailure]);

      const result = await invokeWindTool(
        { ...REQUEST, requestId: `task-10-${category}` },
        dependencies(caller),
      );

      expect(result.toolResult.isError).toBe(true);
      expect(result.notice).toMatchObject({
        code: "WIND_REQUEST_FAILED",
        initialCategory: category,
        finalStatus: "failed",
      });
      expect(caller.slots).toEqual(["key-01"]);
      expect(caller.maxInFlight).toBe(1);
      expect(await slotState("key-02")).toBe("active");
    },
  );

  it("stops an unknown synthetic outcome without retry or next-slot failover", async () => {
    await setNextOutcome("key-01", "unknown");
    const caller = trackedCaller([]);

    const result = await invokeWindTool(
      { ...REQUEST, requestId: "task-10-unknown" },
      dependencies(caller),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "unknown",
    });
    expect(caller.slots).toEqual([]);
    expect(await slotState("key-02")).toBe("active");
  });

  it("serializes overlapping logical requests through the one real coordination atom", async () => {
    const caller = trackedCaller([SUCCESS, SUCCESS], 75);

    const results = await Promise.all([
      invokeWindTool(
        { ...REQUEST, requestId: "task-10-overlap-a" },
        dependencies(caller),
      ),
      invokeWindTool(
        { ...REQUEST, requestId: "task-10-overlap-b" },
        dependencies(caller),
      ),
    ]);

    expect(results.every(({ toolResult }) => toolResult === SUCCESS)).toBe(true);
    expect(caller.maxInFlight).toBe(1);
    expect(caller.slots).toEqual(["key-01", "key-01"]);
  });

  it("keeps every local admin route exact and bounds malformed request bodies", async () => {
    const adminEnv = {
      ADMIN_TOKEN,
      DEPLOYMENT_STAGE: "staging" as const,
      KEY_POOL: env.KEY_POOL,
    };
    const authorized = { authorization: `Bearer ${ADMIN_TOKEN}` };
    const status = await handleAdminRequest(
      new Request("https://gateway.test/admin/key-pool", { headers: authorized }),
      adminEnv,
    );
    expect(status.status).toBe(200);
    expect((await status.json()) as Record<string, unknown>).toMatchObject({ lease: null });

    const requests = [
      [new Request("https://gateway.test/not-admin"), 404],
      [
        new Request("https://gateway.test/admin/key-pool", {
          method: "POST",
          headers: authorized,
        }),
        405,
      ],
      [
        new Request("https://gateway.test/admin/key-pool/slots/key-01/restore", {
          method: "POST",
          headers: { ...authorized, "content-type": "application/json" },
        }),
        400,
      ],
      [
        new Request("https://gateway.test/admin/key-pool/slots/key-01/restore", {
          method: "POST",
          headers: {
            ...authorized,
            "content-type": "application/json",
            "content-length": "4097",
          },
          body: "{}",
        }),
        400,
      ],
      [adminBody("{"), 400],
      [adminBody("[]"), 400],
      [adminBody(new Uint8Array([0xff])), 400],
      [adminBody(new Uint8Array(4097)), 400],
    ] as const;
    for (const [request, expectedStatus] of requests) {
      const response = await handleAdminRequest(request, adminEnv);
      expect(response.status).toBe(expectedStatus);
    }
  });
});

function dependencies(caller: WindToolCaller) {
  return {
    env: {
      KEY_POOL: env.KEY_POOL,
      WIND_API_KEY_01: KEY_01,
      WIND_API_KEY_02: KEY_02,
      DEPLOYMENT_STAGE: "staging",
    },
    caller,
    waitUntil: (promise: Promise<void>) => void promise.catch(() => undefined),
    sleep: async () => undefined,
    log: () => undefined,
  };
}

async function setNextOutcome(
  slotId: "key-01" | "key-02",
  category: WindFailureCategory,
): Promise<void> {
  const response = await admin("/admin/test-controls/next-outcome", {
    slotId,
    category,
    times: 1,
  });
  expect(response.status).toBe(204);
}

async function currentSlotId(): Promise<string> {
  return (await env.KEY_POOL.getByName("private-key-pool").getStatus()).currentSlotId;
}

async function admin(path: string, body: object): Promise<Response> {
  return handleAdminRequest(
    new Request(`https://gateway.test${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    {
      ADMIN_TOKEN,
      DEPLOYMENT_STAGE: "staging",
      KEY_POOL: env.KEY_POOL,
    },
  );
}

async function slotState(slotId: "key-01" | "key-02"): Promise<string | undefined> {
  const status = await env.KEY_POOL.getByName("private-key-pool").getStatus();
  return status.slots.find((slot) => slot.slotId === slotId)?.state;
}

interface TrackedCaller extends WindToolCaller {
  readonly slots: string[];
  readonly maxInFlight: number;
}

function trackedCaller(
  outcomes: readonly (CallToolResult | Error)[],
  delayMs = 0,
): TrackedCaller {
  const remaining = [...outcomes];
  const slots: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    slots,
    get maxInFlight() {
      return maxInFlight;
    },
    async call({ apiKey }) {
      slots.push(apiKey === KEY_01 ? "key-01" : apiKey === KEY_02 ? "key-02" : "unknown");
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const outcome = remaining.shift();
        if (outcome instanceof Error) throw outcome;
        if (outcome === undefined) throw new Error("missing synthetic outcome");
        return outcome;
      } finally {
        inFlight -= 1;
      }
    },
  };
}

function qpsFailure(): WindCallFailure {
  return new WindCallFailure({ status: 429, headers: { "retry-after": "0" } });
}

function structuredFailure(code: string): WindCallFailure {
  return new WindCallFailure({ body: JSON.stringify({ error: { code } }) });
}

function timeoutFailure(): WindCallFailure {
  const error = new Error("synthetic timeout");
  error.name = "AbortError";
  return new WindCallFailure({ error });
}

function adminBody(body: BodyInit): Request {
  return new Request("https://gateway.test/admin/key-pool/slots/key-01/restore", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body,
  });
}
