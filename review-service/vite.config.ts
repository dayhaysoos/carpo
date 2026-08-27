import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    flue({ providers: ["cloudflare"] }),
    react(),
    cloudflare({ config: flueWorkerConfig() }),
  ],
});
