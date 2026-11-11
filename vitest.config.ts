import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    pool: "threads",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
