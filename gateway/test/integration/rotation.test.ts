import type { CallToolResult } from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { handleAdminRequest } from "../../src/admin/handler";
import type { WindFailureCategory } from "../../src/errors/types";
import { invokeWindTool } from "../../src/invocation/invoke";
import type { WindToolCaller } from "../../src/invocation/types";
import { initializeKeyPoolSchema } from "../../src/key-pool/schema";
import {
  KEY_POOL_GENERATIONS,
  KEY_POOL_LAYOUT_ID,
  KEY_POOL_LAYOUTS,
  KEY_SLOT_CATALOG,
  getKeyPoolConfiguration,
  type KeyPoolLayoutDefinition,
  type KeySlotCatalogEntry,
} from "../../src/key-pool/slots";
import { WindCallFailure } from "../../src/upstream/call-tool";

const ADMIN_TOKEN = "task-10-independent-admin";
const KEY_01 = "task-10-key-one";
const KEY_02 = "task-10-key-two";
const KEY_03 = "task-10-key-three";
const REQUEST = {
  requestId: "task-10-rotation",
  toolName: "get_stock_price_indicators",
  input: { windcode: "600519.SH" },
} as const;
const SUCCESS: CallToolResult = {
  content: [{ type: "text", text: "synthetic-success" }],
  isError: false,
};
const FUTURE_BASE_TIME = Date.UTC(2042, 0, 1, 0, 0, 0);

afterEach(async () => {
  await reset();
});

describe("local KeyPool integration", () => {
  it("rotates consecutive canonical daily outcomes as key-03 to key-02 to key-01 to key-03", async () => {
    await setNextOutcome("key-03", "daily_quota");
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

    await setNextOutcome("key-01", "daily_quota");
    const fullWrapCaller = trackedCaller([SUCCESS]);
    const fullWrap = await invokeWindTool(
      { ...REQUEST, requestId: "task-10-full-wrap" },
      dependencies(fullWrapCaller),
    );
    expect(fullWrap.toolResult).toBe(SUCCESS);
    expect(fullWrap.notice).toMatchObject({
      code: "WIND_KEY_ROTATED",
      initialCategory: "daily_quota",
      finalStatus: "succeeded",
    });
    expect(fullWrapCaller.slots).toEqual(["key-03"]);
    expect(await currentSlotId()).toBe("key-03");
  });

  it("tries each slot once per invocation, stops, then re-probes from the persisted cursor", async () => {
    const exhaustedCaller = trackedCaller([
      structuredFailure("DAILY_LIMIT_ERROR"),
      structuredFailure("DAILY_LIMIT_ERROR"),
      structuredFailure("DAILY_LIMIT_ERROR"),
    ]);

    const exhausted = await invokeWindTool(
      { ...REQUEST, requestId: "task-10-bounded-exhaustion" },
      dependencies(exhaustedCaller),
    );

    expect(exhausted.toolResult.isError).toBe(true);
    expect(exhausted.notice).toMatchObject({
      code: "WIND_KEY_ROTATION_FAILED",
      initialCategory: "daily_quota",
      finalStatus: "failed",
    });
    expect(exhaustedCaller.slots).toEqual(["key-03", "key-02", "key-01"]);
    expect(exhaustedCaller.maxInFlight).toBe(1);
    expect(await currentSlotId()).toBe("key-03");

    const nextCaller = trackedCaller([SUCCESS]);
    const next = await invokeWindTool(
      { ...REQUEST, requestId: "task-10-next-invocation" },
      dependencies(nextCaller),
    );

    expect(next.toolResult).toBe(SUCCESS);
    expect(next.notice).toBeNull();
    expect(nextCaller.slots).toEqual(["key-03"]);
    expect(nextCaller.maxInFlight).toBe(1);
  });

  it.each([
    ["qps", qpsFailure()],
    ["concurrency", structuredFailure("CONCURRENCY_LIMIT_ERROR")],
    ["network", new WindCallFailure({ error: new TypeError("synthetic network") })],
    ["upstream_5xx", new WindCallFailure({ status: 503 })],
    ["timeout", timeoutFailure()],
  ] as const)(
    "retries a synthetic %s outcome at most once on key-03 and never selects another slot",
    async (category, terminalFailure) => {
      await setNextOutcome("key-03", category);
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
      expect(caller.slots).toEqual(["key-03"]);
      expect(caller.maxInFlight).toBe(1);
      expect(await slotState("key-02")).toBe("active");
      expect(await currentSlotId()).toBe("key-03");
    },
  );

  it("stops an unknown synthetic outcome without retry or next-slot failover", async () => {
    await setNextOutcome("key-03", "unknown");
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
    expect(await currentSlotId()).toBe("key-03");
  });

  it("stops an oversized-response outcome without moving the cursor", async () => {
    await setNextOutcome("key-03", "response_too_large");
    const caller = trackedCaller([]);

    const result = await invokeWindTool(
      { ...REQUEST, requestId: "task-10-response-too-large" },
      dependencies(caller),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.notice).toMatchObject({
      code: "WIND_REQUEST_FAILED",
      initialCategory: "response_too_large",
      finalStatus: "failed",
    });
    expect(caller.slots).toEqual([]);
    expect(await slotState("key-02")).toBe("active");
    expect(await currentSlotId()).toBe("key-03");
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
    expect(caller.slots).toEqual(["key-03", "key-03"]);
  });

  it("keeps every local admin route exact and bounds malformed request bodies", async () => {
    const adminEnv = {
      ADMIN_TOKEN,
      DEPLOYMENT_STAGE: "staging" as const,
      KEY_POOL: env.KEY_POOL,
      KEY_POOL_LAYOUT_ID,
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

  it("uses an activated successor layout as authority after rollback to its expand candidate", async () => {
    const stub = activeKeyPool();
    await stub.getStatus();
    const futureLayoutId = "ring-primary-future-v2";
    const futureSlotId = "key-04";
    const catalog = KEY_SLOT_CATALOG as unknown as KeySlotCatalogEntry[];
    const layouts = KEY_POOL_LAYOUTS as unknown as Record<string, KeyPoolLayoutDefinition>;
    const futureLayout = {
      layoutId: futureLayoutId,
      generationId: KEY_POOL_GENERATIONS.primary.generationId,
      predecessorLayoutId: KEY_POOL_LAYOUT_ID,
      slotIds: [futureSlotId, "key-03", "key-02", "key-01"],
      initialRingOrder: [futureSlotId, "key-03", "key-02", "key-01"],
      insertedBeforeCursorSlotIds: [futureSlotId],
    } as unknown as KeyPoolLayoutDefinition;
    catalog.push({ slotId: futureSlotId, secretBinding: "WIND_API_KEY_04" });
    layouts[futureLayoutId] = futureLayout;

    try {
      await runInDurableObject(stub, (_instance, state) => {
        initializeKeyPoolSchema(state.storage, FUTURE_BASE_TIME, {
          catalog,
          generation: KEY_POOL_GENERATIONS.primary,
          targetLayout: futureLayout,
          knownLayouts: Object.values(layouts),
          preserveLegacySchema: false,
        });
        state.storage.transactionSync(() => {
          state.storage.sql.exec(
            `UPDATE slots SET call_count = 7, updated_at = ? WHERE slot_id = ?`,
            FUTURE_BASE_TIME + 1,
            futureSlotId,
          );
          state.storage.sql.exec(
            `UPDATE pool_state SET cursor_slot_id = ?, updated_at = ? WHERE singleton = 1`,
            futureSlotId,
            FUTURE_BASE_TIME + 1,
          );
          state.storage.sql.exec(
            `INSERT INTO lease (singleton, lease_id, request_id, slot_id, expires_at)
             VALUES (1, 'future-live-lease', 'future-request', ?, ?)`,
            futureSlotId,
            FUTURE_BASE_TIME + 60_000,
          );
        });
      });
      const beforeRollbackReopen = await versionedSnapshot(stub);

      await evictDurableObject(stub);

      const reopened = await stub.getStatus();
      expect(reopened).toMatchObject({
        currentSlotId: futureSlotId,
        lease: { leaseId: "future-live-lease", slotId: futureSlotId },
      });
      expect(reopened.slots.find(({ slotId }) => slotId === futureSlotId)).toMatchObject({
        slotId: futureSlotId,
        priority: 1,
        state: "active",
        callCount: 7,
      });
      expect(await versionedSnapshot(stub)).toEqual(beforeRollbackReopen);

      const statusResponse = await handleAdminRequest(
        new Request("https://gateway.test/admin/key-pool", {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        adminEnvironment(),
      );
      expect(statusResponse.status).toBe(200);
      const adminStatus = (await statusResponse.json()) as {
        slots: readonly { slotId: string }[];
        lease: { slotId: string } | null;
      };
      expect(adminStatus.slots.some(({ slotId }) => slotId === futureSlotId)).toBe(true);
      expect(adminStatus.lease?.slotId).toBe(futureSlotId);

      await expect(
        stub.acquireLease({
          requestId: "future-live-lease-overlap",
          attemptedSlotIds: [],
          now: FUTURE_BASE_TIME + 2,
        }),
      ).resolves.toMatchObject({ ok: false, code: "GATEWAY_BUSY" });
      const acquired = await stub.acquireLease({
        requestId: "future-tail-acquire",
        attemptedSlotIds: [],
        now: FUTURE_BASE_TIME + 60_000,
      });
      expect(acquired).toMatchObject({ ok: true, slotId: futureSlotId });
      if (!acquired.ok) throw new Error("fixture-future-tail-not-acquired");
      await stub.reportOutcome({
        leaseId: acquired.leaseId,
        slotId: acquired.slotId,
        category: "success",
        resetAt: null,
        occurredAt: FUTURE_BASE_TIME + 60_001,
      });

      expect(
        (await admin(`/admin/key-pool/slots/${futureSlotId}/disable`, {})).status,
      ).toBe(204);
      expect(
        (await stub.getStatus()).slots.find(({ slotId }) => slotId === futureSlotId)?.state,
      ).toBe("disabled_manual");
      expect(
        (await admin(`/admin/key-pool/slots/${futureSlotId}/restore`, {})).status,
      ).toBe(204);
      expect(
        (await stub.getStatus()).slots.find(({ slotId }) => slotId === futureSlotId)?.state,
      ).toBe("active");

      expect(
        (
          await admin("/admin/test-controls/next-outcome", {
            slotId: futureSlotId,
            category: "daily_quota",
            times: 1,
          })
        ).status,
      ).toBe(204);
      await expect(stub.consumeNextTestOutcome(futureSlotId as never)).resolves.toBe(
        "daily_quota",
      );
    } finally {
      delete layouts[futureLayoutId];
      const futureCatalogIndex = catalog.findIndex(({ slotId }) => slotId === futureSlotId);
      if (futureCatalogIndex >= 0) catalog.splice(futureCatalogIndex, 1);
    }
  });
});

function dependencies(caller: WindToolCaller) {
  return {
    env: {
      KEY_POOL: env.KEY_POOL,
      WIND_API_KEY_01: KEY_01,
      WIND_API_KEY_02: KEY_02,
      WIND_API_KEY_03: KEY_03,
      KEY_POOL_LAYOUT_ID,
      DEPLOYMENT_STAGE: "staging",
    },
    caller,
    waitUntil: (promise: Promise<void>) => void promise.catch(() => undefined),
    sleep: async () => undefined,
    log: () => undefined,
  };
}

async function setNextOutcome(
  slotId: "key-01" | "key-02" | "key-03",
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
  return (await activeKeyPool().getStatus()).currentSlotId;
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
    adminEnvironment(),
  );
}

function adminEnvironment() {
  return {
    ADMIN_TOKEN,
    DEPLOYMENT_STAGE: "staging" as const,
    KEY_POOL: env.KEY_POOL,
    KEY_POOL_LAYOUT_ID,
  };
}

async function versionedSnapshot(stub: ReturnType<typeof activeKeyPool>) {
  return runInDurableObject(stub, (_instance, state) => ({
    slots: state.storage.sql.exec("SELECT * FROM slots ORDER BY priority").toArray(),
    lease: state.storage.sql.exec("SELECT * FROM lease").toArray(),
    cursor: state.storage.sql.exec("SELECT * FROM pool_state").toArray(),
    manifest: state.storage.sql.exec("SELECT * FROM pool_manifest").toArray(),
    outcomes: state.storage.sql.exec("SELECT * FROM pending_test_outcome").toArray(),
    markers: state.storage.sql.exec("SELECT * FROM oauth_replay_marker ORDER BY marker_id").toArray(),
    versions: state.storage.sql
      .exec("SELECT * FROM _key_pool_schema_migrations ORDER BY version")
      .toArray(),
  }));
}

async function slotState(slotId: "key-01" | "key-02" | "key-03"): Promise<string | undefined> {
  const status = await activeKeyPool().getStatus();
  return status.slots.find((slot) => slot.slotId === slotId)?.state;
}

function activeKeyPool() {
  return env.KEY_POOL.getByName(getKeyPoolConfiguration(KEY_POOL_LAYOUT_ID).generation.objectName);
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
      slots.push(
        apiKey === KEY_01
          ? "key-01"
          : apiKey === KEY_02
            ? "key-02"
            : apiKey === KEY_03
              ? "key-03"
              : "unknown",
      );
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
