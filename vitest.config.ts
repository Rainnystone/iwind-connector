import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      include: ["gateway/src/**/*.ts"],
      exclude: ["gateway/src/**/*.d.ts"],
      reporter: ["text", "text-summary", "json"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
    projects: [
      {
        test: {
          name: "node",
          include: ["gateway/test/**/*.test.ts", "skill/test/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [
            "gateway/test/key-pool/**/*.test.ts",
            "gateway/test/invocation/**/*.test.ts",
            "gateway/test/index.test.ts",
            "gateway/test/auth/oauth.test.ts",
            "gateway/test/auth/authorization-replay.test.ts",
            "gateway/test/integration/oauth-mcp.test.ts",
            "gateway/test/integration/rotation.test.ts",
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
            "gateway/test/integration/oauth-mcp.test.ts",
            "gateway/test/integration/rotation.test.ts",
          ],
        },
      },
    ],
  },
});
