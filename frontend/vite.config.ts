import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// In dev the browser talks only to Vite; /api is forwarded to the till API (backend, :3000), so there is no CORS.
// In production the till API serves this build itself (FRONTEND_DIR), also on one origin.
const API = process.env.VITE_API_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target: API, changeOrigin: false } } },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["src/test-setup.ts"] },
});
