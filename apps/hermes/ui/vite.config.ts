import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Load VITE_* from spacekit.xyz-website/.env so Hermes matches website endpoints. */
const websiteEnvDir = path.resolve(__dirname, "../../../../spacekit.xyz-website");

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Single bundle — blob iframes cannot resolve relative dynamic-import chunks.
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    // WalletConnect / Reown pull in nested `ox` builds with /*#__PURE__*/ on regex/object
    // literals — valid for esbuild, noisy under Rolldown (Vite 8). Harmless; suppress spam.
    rolldownOptions: {
      onLog(level, log, defaultHandler) {
        if (log.code === "INVALID_ANNOTATION") return;
        defaultHandler(level, log);
      },
    },
  },
  envDir: websiteEnvDir,
});
