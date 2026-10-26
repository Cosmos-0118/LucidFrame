import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const here = import.meta.dirname;

export default defineConfig({
  root: here,
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(here, "..", "..", "dist", "renderer"),
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome140",
  },
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
});
