import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["*.ui.test.tsx", "*.backend.test.ts"],
    setupFiles: ["./test-setup.ts"],
  },
});
