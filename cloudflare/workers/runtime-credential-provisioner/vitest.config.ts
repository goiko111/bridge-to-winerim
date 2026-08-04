import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["cloudflare/workers/runtime-credential-provisioner/src/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
