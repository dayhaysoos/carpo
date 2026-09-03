import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [stylex.vite(), react()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/auth/login": "http://localhost:8787",
      "/share": "http://localhost:8787",
      "/api": "http://localhost:8787",
      "/artifacts": "http://localhost:8787",
      "/agents": {
        target: "http://localhost:8787",
        ws: true,
      },
    },
  },
});
