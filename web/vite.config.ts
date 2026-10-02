import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 静的なファイルだけを出力する。CDKの合成のときに、出力先を指定してビルドする（web-frontend.ts）
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { emptyOutDir: true },
});
