import { defineConfig } from "vite-plus";

// The main process and the preload, bundled to CommonJS for Electron. Electron itself stays
// outside the bundle; everything else is bundled, so the packaged app needs no node_modules.
const isElectron = (id: string) => id === "electron" || id.startsWith("electron/");

const electronEntry = (entry: string) => ({
  entry: [entry],
  format: "cjs" as const,
  outDir: "dist-electron",
  dts: false,
  sourcemap: true,
  clean: false,
  outExtensions: () => ({ js: ".cjs" }),
  outputOptions: { codeSplitting: false },
  deps: {
    alwaysBundle: (id: string) => !id.startsWith("node:") && !isElectron(id),
    neverBundle: isElectron,
  },
});

export default defineConfig({
  pack: [electronEntry("src/main/main.ts"), electronEntry("src/preload/preload.ts")],
});
