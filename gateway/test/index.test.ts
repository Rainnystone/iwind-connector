import { describe, expect, it } from "vitest";

import worker from "../src/index";

describe("gateway worker", () => {
  it("returns a minimal 404 response before MCP routes are registered", async () => {
    const responsePromise = worker.fetch();

    expect(responsePromise).toBeInstanceOf(Promise);
    const response = await responsePromise;
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not Found");
  });
});
