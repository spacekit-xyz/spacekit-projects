import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths for SpaceKit app packages (HTML runs from a blob URL in iframe).
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});