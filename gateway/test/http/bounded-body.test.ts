import { describe, expect, it } from "vitest";

import {
  BoundedBodyTooLargeError,
  rebuildRequestWithBoundedBody,
  rebuildResponseWithBoundedBody,
} from "../../src/http/bounded-body";

describe("bounded HTTP bodies", () => {
  it("accepts request and response bodies at the exact limit", async () => {
    const request = await rebuildRequestWithBoundedBody(
      new Request("https://gateway.test/oauth/token", { method: "POST", body: "1234" }),
      4,
    );
    const response = await rebuildResponseWithBoundedBody(new Response("1234"), 4);

    await expect(request.text()).resolves.toBe("1234");
    await expect(response.text()).resolves.toBe("1234");
  });

  it.each(["request", "response"] as const)(
    "cancels a streamed %s body after crossing the limit without Content-Length",
    async (kind) => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(1));
        },
        cancel() {
          cancelled = true;
        },
      });
      const operation =
        kind === "request"
          ? rebuildRequestWithBoundedBody(
              new Request("https://gateway.test/oauth/token", {
                method: "POST",
                body,
                duplex: "half",
              } as RequestInit & { duplex: "half" }),
              4,
            )
          : rebuildResponseWithBoundedBody(new Response(body), 4);

      await expect(operation).rejects.toBeInstanceOf(BoundedBodyTooLargeError);
      expect(cancelled).toBe(true);
    },
  );

  it("cancels immediately when a declared Content-Length exceeds the limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://gateway.test/oauth/token", {
      method: "POST",
      headers: { "content-length": "5" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(rebuildRequestWithBoundedBody(request, 4)).rejects.toBeInstanceOf(
      BoundedBodyTooLargeError,
    );
    expect(cancelled).toBe(true);
  });
});
