import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.SERVER_PORT ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
});
