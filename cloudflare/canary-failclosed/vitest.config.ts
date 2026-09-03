import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "cloudflare/canary-failclosed/test/**/*.test.ts",
      "cloudflare/canary-failclosed/src/**/*.test.ts",
    ],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
