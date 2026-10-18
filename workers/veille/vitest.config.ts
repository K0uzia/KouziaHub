import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Alias de l'API : le test d'interopérabilité charge le client du hub (apps/api/src/lib/monitor).
  resolve: {
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("../../apps/api/src/", import.meta.url)) }],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
