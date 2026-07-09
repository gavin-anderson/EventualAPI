import { defineConfig } from "vitest/config";

export default defineConfig({
  // The source uses NodeNext-style ".js" import specifiers that resolve to ".ts"
  // on disk; teach Vite's resolver to try ".ts" first so tests load the sources.
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
