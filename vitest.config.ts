import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["gateway/test/**/*.test.ts"],
  },
});
