import { describe, expect, it } from "vitest";

import { encodeOpsNotice } from "../../src/notices/encode";
import type { OpsNoticeV1 } from "../../src/notices/types";

describe("Wind operations notice encoder", () => {
  const rotated: OpsNoticeV1 = {
    schemaVersion: 1,
    code: "WIND_KEY_ROTATED",
    initialCategory: "daily_quota",
    finalStatus: "succeeded",
    requestId: "opaque-request-id",
  };

  it("emits the deterministic final text content block wire format", () => {
    expect(encodeOpsNotice(rotated)).toEqual({
      type: "text",
      text: 'IWIND_OPS_NOTICE_V1 {"schemaVersion":1,"code":"WIND_KEY_ROTATED","initialCategory":"daily_quota","finalStatus":"succeeded","requestId":"opaque-request-id"}',
    });
  });

  it("does not add a notice to normal success", () => {
    expect(encodeOpsNotice(null)).toBeNull();
  });

  it("uses only allowlisted fields even when an untyped caller supplies sensitive details", () => {
    const unsafe = {
      ...rotated,
      slotId: "slot-7",
      authorization: "Bearer synthetic-secret",
      rawMessage: "daily limit synthetic detail",
      arguments: { windcode: "SYNTHETIC" },
      response: { balance: 0 },
    };
    const encoded = encodeOpsNotice(unsafe);

    expect(encoded?.text).not.toContain("slot-7");
    expect(encoded?.text).not.toContain("synthetic-secret");
    expect(encoded?.text).not.toContain("daily limit synthetic detail");
    expect(encoded?.text).not.toContain("SYNTHETIC");
    expect(encoded?.text).not.toContain("balance");
  });

  it("rejects non-allowlisted notice enums instead of serializing them", () => {
    expect(() =>
      encodeOpsNotice({
        schemaVersion: 1,
        code: "UNSAFE_CODE",
        initialCategory: "daily_quota",
        finalStatus: "succeeded",
        requestId: "opaque-request-id",
      }),
    ).toThrow("invalid ops notice");
  });

  it("rejects a failed rotated notice", () => {
    expect(() =>
      encodeOpsNotice({
        ...rotated,
        finalStatus: "failed",
      }),
    ).toThrow("invalid ops notice");
  });

  it.each([
    "WIND_KEY_ROTATION_FAILED",
    "KEY_POOL_EXHAUSTED",
    "GATEWAY_BUSY",
    "WIND_REQUEST_FAILED",
  ])("rejects succeeded status for failure notice %s", (code) => {
    expect(() =>
      encodeOpsNotice({
        ...rotated,
        code,
      }),
    ).toThrow("invalid ops notice");
  });
});
