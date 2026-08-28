import { defineConfig } from "@flue/runtime/config";

export default defineConfig({
  target: "cloudflare",
  app: "src/app.ts",
  cloudflare: "src/cloudflare.ts",
  agents: "agents/**/*.ts",
  providers: ["cloudflare"],
  tracing: false,
});
