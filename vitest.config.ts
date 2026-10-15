import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The dashboard's own `@/` imports (apps/dashboard/tsconfig.json paths).
      "@": fileURLToPath(new URL("apps/dashboard", import.meta.url)),
      // Next.js resolves "server-only" to an empty module on the server and fails a client build
      // that imports it; plain Node gets the throwing variant, so tests use the empty one.
      "server-only": fileURLToPath(
        new URL("apps/dashboard/node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
      "apps/*/{app,components,features,lib,scripts}/**/*.test.{ts,tsx}",
    ],
    environment: "node",
  },
});
