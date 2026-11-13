import { defineConfig } from 'vite';

// Relative base so the built app also works when opened from arbitrary paths
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    watch: {
      // 测试输出/下载文件在项目目录内频繁写入，Windows 下会触发 EBUSY 拖垮 watcher
      ignored: ['**/test-output/**', '**/dist/**', '**/node_modules/**'],
    },
  },
});
