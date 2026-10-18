import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  envDir: path.resolve(__dirname, "../.."),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@hub/contract": path.resolve(__dirname, "../api/src/contract.ts"),
      // Règles des chemins partagées avec le serveur (fichiers écartés avant l'envoi) : module sans code serveur.
      "@hub/site-paths": path.resolve(__dirname, "../api/src/lib/site-paths.ts"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const n = id.split(String.fromCharCode(92)).join("/");
          if (!n.includes("/node_modules/")) return undefined;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(n)) return "react";
          if (n.includes("/node_modules/react-router")) return "router";
          if (n.includes("/node_modules/@fortawesome/")) return "icons";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": { target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3101", changeOrigin: false },
    },
  },
});
