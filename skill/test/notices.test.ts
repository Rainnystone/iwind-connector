import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { encodeOpsNotice } from "../../gateway/src/notices/encode";
import type { OpsNoticeV1 } from "../../gateway/src/notices/types";

interface NoticeCase {
  readonly id: string;
  readonly notice: OpsNoticeV1 | null;
  readonly queryCompleted: boolean;
  readonly mayUseData: boolean;
  readonly operationsSentence: string | null;
}

const ROOT = path.resolve(import.meta.dirname, "../..");

async function cases(): Promise<ReadonlyArray<NoticeCase>> {
  return JSON.parse(
    await readFile(path.join(ROOT, "skill/evals/notice-cases.json"), "utf8"),
  ) as ReadonlyArray<NoticeCase>;
}

describe("operations notice evals", () => {
  it("uses the canonical Task 3 wire values and status pairings", async () => {
    const fixtures = await cases();
    const codes = fixtures.flatMap(({ notice }) => (notice === null ? [] : [notice.code]));

    expect(codes).toEqual([
      "WIND_KEY_ROTATED",
      "WIND_KEY_ROTATION_FAILED",
      "KEY_POOL_EXHAUSTED",
      "GATEWAY_BUSY",
      "WIND_REQUEST_FAILED",
    ]);
    for (const fixture of fixtures) {
      expect(() => encodeOpsNotice(fixture.notice)).not.toThrow();
      if (fixture.notice?.code === "WIND_KEY_ROTATED") {
        expect(fixture.notice.finalStatus).toBe("succeeded");
      } else if (fixture.notice !== null) {
        expect(fixture.notice.finalStatus).toBe("failed");
      }
    }
  });

  it("adds no operations sentence to normal success", async () => {
    const normal = (await cases()).find(({ id }) => id === "normal-success");

    expect(normal).toEqual({
      id: "normal-success",
      notice: null,
      queryCompleted: true,
      mayUseData: true,
      operationsSentence: null,
    });
  });

  it("keeps rotated success data-valid and states error, rotation, and success once", async () => {
    const rotated = (await cases()).find(({ id }) => id === "rotated-success");

    expect(rotated?.queryCompleted).toBe(true);
    expect(rotated?.mayUseData).toBe(true);
    expect(rotated?.operationsSentence).toMatch(/明确错误/);
    expect(rotated?.operationsSentence).toMatch(/自动轮换/);
    expect(rotated?.operationsSentence).toMatch(/本次查询成功/);
    expect(rotated?.operationsSentence?.match(/。/g)).toHaveLength(1);
  });

  it("never turns a failed notice into empty or successful data", async () => {
    const failed = (await cases()).filter(({ notice }) => notice?.finalStatus === "failed");

    expect(failed).toHaveLength(4);
    for (const fixture of failed) {
      expect(fixture.queryCompleted, fixture.id).toBe(false);
      expect(fixture.mayUseData, fixture.id).toBe(false);
      expect(fixture.operationsSentence, fixture.id).toMatch(/^本次查询未完成/);
      expect(fixture.operationsSentence, fixture.id).not.toMatch(/无数据|数据为空|结果为空|0 条|查询成功/);
    }
  });

  it("keeps every human sentence free of credential and raw-diagnostic concepts", async () => {
    const fixtures = await cases();
    const forbidden = /key|密钥|凭证|slot|token|requestId|raw body|error message/i;

    for (const fixture of fixtures) {
      if (fixture.operationsSentence !== null) {
        expect(fixture.operationsSentence, fixture.id).not.toMatch(forbidden);
        expect(fixture.operationsSentence.match(/。/g), fixture.id).toHaveLength(1);
      }
    }
  });

  it("places the canonical human sentences in the shared Skill instructions", async () => {
    const source = await readFile(path.join(ROOT, "skill/SKILL.md"), "utf8");
    const fixtures = await cases();

    for (const sentence of fixtures.flatMap(({ operationsSentence }) =>
      operationsSentence === null ? [] : [operationsSentence],
    )) {
      expect(source).toContain(sentence);
    }
    expect(source).toMatch(/answer the data first/i);
    expect(source).toMatch(/failure[^\n]+(?:not empty data|never empty data)/i);
  });
});
