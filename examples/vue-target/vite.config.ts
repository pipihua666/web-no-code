import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { webNoCodeInspector } from "../../packages/vite-inspector-plugin/src";

export default defineConfig({
  plugins: [vue(), webNoCodeInspector()],
  css: {
    devSourcemap: true
  },
  server: {
    port: 5174,
    host: "0.0.0.0"
  }
});
