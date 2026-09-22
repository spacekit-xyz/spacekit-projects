import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Load VITE_* from spacekit.xyz-website/.env so Harmonia matches website endpoints. */
const websiteEnvDir = path.resolve(__dirname, "../../../../spacekit.xyz-website");

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Blob iframes cannot resolve relative dynamic-import chunks.
    codeSplitting: false,
  },
  envDir: websiteEnvDir,
});
