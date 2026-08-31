import { describe, expect, it } from "vitest";

import { handleAdminRequest } from "../../src/admin/handler";
import type { WindFailureCategory } from "../../src/errors/types";
import { KEY_SLOT_DEFINITIONS } from "../../src/key-pool/slots";

const ADMIN_TOKEN = "independent-admin-token";
const NOW = Date.UTC(2035, 7, 24);

describe("independent admin surface", () => {
  it.each([
    ["missing bearer", undefined, 401],
    ["malformed bearer", "Basic abc", 401],
    ["wrong bearer", "Bearer wrong", 403],
    ["OAuth bearer", "Bearer oauth-access-token", 403],
  ] as const)("rejects %s", async (_name, authorization, status) => {
    const headers = authorization === undefined ? undefined : { authorization };
    const response = await handleAdminRequest(
      new Request("https://gateway.test/admin/key-pool", { headers }),
      adminEnv("staging"),
      NOW,
    );
    expect(response.status).toBe(status);
  });

  it("returns only redacted pool state and performs exact restore/disable routes", async () => {
    const fixture = adminEnv("staging");
    const status = await handleAdminRequest(adminRequest("/admin/key-pool"), fixture, NOW);
    const body = await status.text();
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain('"slotId":"key-01"');
    expect(body).not.toContain("lease-secret");
    expect(body).not.toContain("request-secret");
    expect(body).not.toContain(ADMIN_TOKEN);
    expect(body).not.toContain("allowed@example.test");

    await expect(
      handleAdminRequest(
        adminRequest("/admin/key-pool/slots/key-01/disable", "POST", {}),
        fixture,
        NOW,
      ),
    ).resolves.toMatchObject({ status: 204 });
    await expect(
      handleAdminRequest(
        adminRequest("/admin/key-pool/slots/key-01/restore", "POST", {}),
        fixture,
        NOW + 1,
      ),
    ).resolves.toMatchObject({ status: 204 });
    expect(fixture.calls).toEqual([
      ["disable", "key-01", NOW],
      ["restore", "key-01", NOW + 1],
    ]);
  });

  it("accepts restore and disable routes for every manifest slot", async () => {
    const fixture = adminEnv("staging");
    for (const definition of KEY_SLOT_DEFINITIONS) {
      await expect(
        handleAdminRequest(
          adminRequest(`/admin/key-pool/slots/${definition.slotId}/disable`, "POST", {}),
          fixture,
          NOW,
        ),
      ).resolves.toMatchObject({ status: 204 });
      await expect(
        handleAdminRequest(
          adminRequest(`/admin/key-pool/slots/${definition.slotId}/restore`, "POST", {}),
          fixture,
          NOW + 1,
        ),
      ).resolves.toMatchObject({ status: 204 });
    }
    expect(fixture.calls).toEqual(
      KEY_SLOT_DEFINITIONS.flatMap(({ slotId }) => [
        ["disable", slotId, NOW],
        ["restore", slotId, NOW + 1],
      ]),
    );
  });

  it("requires exact JSON objects and exact admin routes", async () => {
    const fixture = adminEnv("staging");
    const wrongType = await handleAdminRequest(
      new Request("https://gateway.test/admin/key-pool/slots/key-01/restore", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "text/plain" },
        body: "{}",
      }),
      fixture,
      NOW,
    );
    expect(wrongType.status).toBe(415);
    const extra = await handleAdminRequest(
      adminRequest("/admin/key-pool/slots/key-01/restore", "POST", { extra: true }),
      fixture,
      NOW,
    );
    expect(extra.status).toBe(400);
    await expect(
      handleAdminRequest(adminRequest("/admin/key-pool/slots/key-01/restore/extra"), fixture, NOW),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("hides every test-control route outside staging before exposing a token oracle", async () => {
    for (const stage of ["production", "local"] as const) {
      const response = await handleAdminRequest(
        new Request("https://gateway.test/admin/test-controls/next-outcome", {
          method: "POST",
          headers: { authorization: "Bearer wrong", "content-type": "application/json" },
          body: JSON.stringify({ slotId: "key-01", category: "daily_quota", times: 1 }),
        }),
        adminEnv(stage),
        NOW,
      );
      expect(response.status).toBe(404);
    }
  });

  it("sets only an exact one-shot canonical failure in staging", async () => {
    const fixture = adminEnv("staging");
    const accepted = await handleAdminRequest(
      adminRequest("/admin/test-controls/next-outcome", "POST", {
        slotId: "key-01",
        category: "daily_quota",
        times: 1,
      }),
      fixture,
      NOW,
    );
    expect(accepted.status).toBe(204);
    expect(fixture.controls).toEqual([{ slotId: "key-01", category: "daily_quota" }]);

    for (const body of [
      { slotId: "key-01", category: "success", times: 1 },
      { slotId: "key-01", category: "daily_quota", times: 2 },
      { slotId: "key-01", category: "daily_quota", times: 1, params: { secret: true } },
    ]) {
      const response = await handleAdminRequest(
        adminRequest("/admin/test-controls/next-outcome", "POST", body),
        fixture,
        NOW,
      );
      expect(response.status).toBe(400);
    }
  });
});

function adminRequest(path: string, method = "GET", body?: object): Request {
  return new Request(`https://gateway.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function adminEnv(stage: "local" | "staging" | "production") {
  const calls: Array<[string, string, number]> = [];
  const controls: Array<{ slotId: string; category: WindFailureCategory }> = [];
  const stub = {
    async getStatus() {
      return {
        slots: [
          {
            slotId: "key-01",
            priority: 1,
            state: "active",
            resetAt: null,
            cooldownUntil: null,
            lastErrorCode: "raw-error-must-not-escape",
            callCount: 0,
            updatedAt: NOW,
          },
        ],
        lease: {
          leaseId: "lease-secret",
          requestId: "request-secret",
          slotId: "key-01",
          expiresAt: NOW + 1,
        },
      };
    },
    async disableSlot(slotId: string, now: number) {
      calls.push(["disable", slotId, now]);
    },
    async restoreSlot(slotId: string, now: number) {
      calls.push(["restore", slotId, now]);
    },
    async setNextTestOutcome(outcome: { slotId: string; category: WindFailureCategory }) {
      controls.push(outcome);
    },
  };
  return {
    ADMIN_TOKEN,
    DEPLOYMENT_STAGE: stage,
    KEY_POOL: { getByName: () => stub },
    calls,
    controls,
  } as never as Cloudflare.Env & {
    calls: typeof calls;
    controls: typeof controls;
  };
}
