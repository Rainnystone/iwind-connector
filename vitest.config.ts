import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["gateway/test/**/*.test.ts"],
          exclude: [
            "gateway/test/key-pool/**/*.test.ts",
            "gateway/test/invocation/**/*.test.ts",
            "gateway/test/index.test.ts",
            "gateway/test/auth/oauth.test.ts",
            "gateway/test/auth/authorization-replay.test.ts",
          ],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "gateway/wrangler.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: [
            "gateway/test/key-pool/**/*.test.ts",
            "gateway/test/invocation/**/*.test.ts",
            "gateway/test/index.test.ts",
            "gateway/test/auth/oauth.test.ts",
            "gateway/test/auth/authorization-replay.test.ts",
          ],
        },
      },
    ],
  },
});
