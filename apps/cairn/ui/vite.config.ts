import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cairnGrowformerAgents } from "./vite-growformer-agents";

export default defineConfig({
  plugins: [react(), cairnGrowformerAgents()],
  // Relative asset paths for SpaceKit app packages (HTML runs from a blob URL in iframe).
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
