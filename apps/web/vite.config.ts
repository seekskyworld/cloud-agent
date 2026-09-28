/** 开发代理保持同源；构建产物由 API 静态服务提供。 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/v1": process.env.WEB_API_URL ?? "http://127.0.0.1:3100",
      "/health": process.env.WEB_API_URL ?? "http://127.0.0.1:3100",
    },
  },
});
