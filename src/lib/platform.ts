// 平台判断 —— 只服务于「界面上该显示哪个按键」这一件事。
//
// 真正的快捷键有两套来源，这里的文案必须跟它们对得上：
//   1. 全局捕捉热键在 Rust 侧注册（src-tauri/src/shortcut.rs，权威）：
//      macOS 是 Opt+Space，其余平台是 Ctrl+Alt+Space。
//   2. 搜索面板（⌘/Ctrl+K）和快捕保存（⌘/Ctrl+Enter）是前端自己监听的，
//      判断条件都是 `metaKey || ctrlKey`，所以两个平台按各自习惯的那个键即可。
//
// 为什么用 navigator.userAgent 而不是 navigator.platform：
//   navigator.platform 已被标准废弃，各引擎对它的态度正在分化（有的冻结成固定值、
//   有的计划移除），而 userAgent 在 WKWebView(macOS) 与 WebView2(Windows) 里都必然存在，
//   且都带明确的系统标识（"Macintosh; Intel Mac OS X" / "Windows NT"）。
//   userAgent 有被改写的风险，但在我们自己打包的 Tauri webview 里没人会去改它。
//
// 判断失败时（拿不到 navigator、UA 为空）一律退化成「非 macOS」：
//   Ctrl+Alt+Space / Ctrl+K 这类写法 mac 用户至少能看懂是在说什么，
//   反过来把 ⌘⌥ 这些符号丢给 Windows 用户就是天书了。

/**
 * 纯函数版平台判断，方便直接喂 UA 字符串做单测。
 *
 * 传入空值（拿不到 navigator 等情况）返回 false，即按非 macOS 处理。
 */
export function detectIsMac(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  // macOS 的 UA 里一定带 "Macintosh" / "Mac OS X"，其它桌面平台不会出现 "mac" 这个词。
  return /mac/i.test(userAgent)
}

/** 当前运行环境是否 macOS。取不到 navigator 时按非 macOS 处理。 */
export const isMac: boolean =
  typeof navigator === 'undefined' ? false : detectIsMac(navigator.userAgent)

export interface ShortcutLabels {
  /** 全局捕捉热键，跟 src-tauri/src/shortcut.rs 注册的一致。 */
  capture: string
  /** 主窗口唤起搜索面板。 */
  search: string
  /** 快捕窗口保存并关闭。 */
  save: string
}

/** 按平台给出一组按键文案。抽成纯函数是为了两个分支都能单测。 */
export function shortcutLabels(mac: boolean): ShortcutLabels {
  return mac
    ? { capture: '⌥Space', search: '⌘K', save: '⌘Enter' }
    : { capture: 'Ctrl+Alt+Space', search: 'Ctrl+K', save: 'Ctrl+Enter' }
}

/** 当前平台的按键文案，界面上直接用这个。 */
export const keys: ShortcutLabels = shortcutLabels(isMac)
