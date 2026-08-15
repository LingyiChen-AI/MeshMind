import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri 在开发模式下固定连 1420 端口，端口被占时必须报错而不是自动换端口，
// 否则外壳会连到一个空地址上，症状是白屏且没有任何提示。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2021' },
})
