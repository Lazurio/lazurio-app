import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// The interface of the app's local windows, served from lazurio-app://shell.
export default defineConfig({
  root: "src/ui",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist-ui",
    emptyOutDir: true,
  },
});
