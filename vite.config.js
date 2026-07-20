import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 构建产物：单个自包含的 dist/index.html
// CSS / JS / PDF worker 全部内联，可离线分发、双击即用。
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: 'esnext',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
  },
  worker: { format: 'es' },
});
