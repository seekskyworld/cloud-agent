/** 开发代理保持同源；构建产物由 API 静态服务提供。 */
import { site } from "../../modules/site.js";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    {
      name: "static-site-entry",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          if (!/^\/src\/[A-Za-z0-9/_-]+\.tsx?$/.test(site.entry))
            throw new Error("SITE_ENTRY_INVALID");
          const title = site.title.replace(
            /[&<>"']/g,
            (c) =>
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              })[c]!,
          );
          return html
            .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
            .replace('src="/src/main.tsx"', `src="${site.entry}"`);
        },
      },
    },
  ],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/public": process.env.WEB_API_URL ?? "http://127.0.0.1:3100",
      "/v1": process.env.WEB_API_URL ?? "http://127.0.0.1:3100",
      "/health": process.env.WEB_API_URL ?? "http://127.0.0.1:3100",
    },
  },
});
