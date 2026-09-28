import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({ plugins: [react()], build: { outDir: "dist-reconciliation-preview", emptyOutDir: true, rollupOptions: { input: "reconciliation-preview.html" } } });
