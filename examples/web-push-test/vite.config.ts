import { defineConfig } from "vite";

// Plain Vite. The SDK is a CommonJS package that `npm run prepare:sdk` places in node_modules, so
// Vite pre-bundles it like any other dependency.
export default defineConfig({
  server: { port: 5173 },
});
