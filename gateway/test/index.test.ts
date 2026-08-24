import { describe, expect, it } from "vitest";

import worker from "../src/index";

describe("gateway worker", () => {
  it("keeps the default Worker surface closed until Task 7 OAuth delegates authenticated props", async () => {
    const responsePromise = worker.fetch(new Request("https://gateway.test/mcp"));

    expect(responsePromise).toBeInstanceOf(Promise);
    const response = await responsePromise;
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("Forbidden");

    const other = await worker.fetch(new Request("https://gateway.test/unknown"));
    expect(other.status).toBe(404);
  });
});
