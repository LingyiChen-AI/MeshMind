import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri 在开发模式下固定连 1420 端口，端口被占时必须报错而不是自动换端口，
// 否则外壳会连到一个空地址上，症状是白屏且没有任何提示。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2021' },
  // 测试的都是纯函数（正文 JSON 解析、拼音高亮、命名转换），不碰 DOM，
  // 所以 environment 留在 node——引 jsdom 只会拖慢启动。
  // 但 include 必须同时收 .tsx：collectAttachmentIds 这类函数曾经就住在 .tsx 里，
  // 只收 .ts 等于让它们悄悄零覆盖。
  test: { environment: 'node', include: ['ui/**/*.test.{ts,tsx}'] },
})
