import { defineConfig } from '@playwright/test'

// 只跑 chromium：真实运行环境是 WKWebView / WebView2，
// 多装两个引擎并不会更接近真实，只会让 CI 更慢。
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // CI 上除了 github 注解，还要出一份 html 报告：trace 就装在 playwright-report/ 里，
  // 只留 github 注解的话失败时能看到的仅有一句断言消息，而这套测试里最难查的
  // 恰恰是时序问题——没有 trace 基本没法远程复现。
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
