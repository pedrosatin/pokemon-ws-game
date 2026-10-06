import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "cloudflare:workers": new URL("./worker/test-worker-runtime.ts", import.meta.url).pathname } },
  test: {
    environment: "node",
    include: ["shared/**/*.test.ts", "src/**/*.test.ts", "worker/**/*.test.ts"],
  },
});
