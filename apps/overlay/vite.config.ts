import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/overlay/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        overlay: fileURLToPath(new URL("index.html", import.meta.url)),
        scene: fileURLToPath(new URL("scene.html", import.meta.url)),
        faces: fileURLToPath(new URL("face-sheet.html", import.meta.url)),
      },
    },
  },
  worker: { format: "es" },
});
