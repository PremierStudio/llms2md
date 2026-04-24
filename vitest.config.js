import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: true,
      exclude: [
        ".github/**",
        "coverage/**",
        "node_modules/**",
        "test/**",
        "vitest.config.js",
      ],
      include: [
        "index.js",
        "lib/**/*.js",
        "scripts/check-registry-safety.mjs",
      ],
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    environment: "node",
  },
});
