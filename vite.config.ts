import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "web/src") },
  },
  worker: { format: "es" },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: path.resolve(__dirname, "web/src/main.tsx") },
  },
  server: {
    port: 5173,
    strictPort: true,
    cors: true,
    origin: "http://localhost:5173",
    proxy: {
      "/api": {
        target: process.env.PORT ? `http://localhost:${process.env.PORT}` : "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
