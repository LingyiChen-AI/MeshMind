import { describe, expect, it } from 'vitest'

import { detectIsMac, shortcutLabels } from './platform'

// 真实 UA：Tauri 的 webview 直接复用系统 WebKit / WebView2，UA 形态跟浏览器一致。
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

describe('detectIsMac', () => {
  it('认出 macOS', () => {
    expect(detectIsMac(MAC_UA)).toBe(true)
  })

  it('Windows 和 Linux 都不是 mac', () => {
    expect(detectIsMac(WINDOWS_UA)).toBe(false)
    expect(detectIsMac(LINUX_UA)).toBe(false)
  })

  it('拿不到 UA 时退化成非 mac（Ctrl 系文案 mac 用户也看得懂）', () => {
    expect(detectIsMac(undefined)).toBe(false)
    expect(detectIsMac(null)).toBe(false)
    expect(detectIsMac('')).toBe(false)
  })
})

describe('shortcutLabels', () => {
  it('mac 用符号', () => {
    expect(shortcutLabels(true)).toEqual({
      capture: '⌥Space',
      search: '⌘K',
      save: '⌘Enter',
      ai: '⌘L',
    })
  })

  // 全局热键文案必须跟 crates/shell/src/shortcut.rs 注册的 CONTROL|ALT + Space 一致。
  it('非 mac 用 Ctrl 系写法', () => {
    expect(shortcutLabels(false)).toEqual({
      capture: 'Ctrl+Alt+Space',
      search: 'Ctrl+K',
      save: 'Ctrl+Enter',
      ai: 'Ctrl+L',
    })
  })
})
