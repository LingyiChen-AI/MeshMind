// 设置项的键名与「字符串 ↔ 语义」的翻译。
//
// 外壳（Rust）只认字符串：`get_settings` 返回的是一张 BTreeMap<String, String>，
// 值的解释权全在前端。这份翻译必须和 crates/shell/src/settings.rs 逐字对齐——
// 对不上的后果不是报错而是**静默的不一致**：设置页显示「已开启」，
// 而下次启动时外壳按 false 解释，用户会以为开关坏了。
//
// 抽成纯函数是因为这里全是「缺键 / 空值 / 认不出的值」这类边角：
// 三个开关里有两个（隐藏 Dock、开机自启）默认是关，热键默认是平台默认键而不是空。

/** 允许写入 settings 表的键名，和 Rust 的 `settings::ALLOWED_KEYS` 一一对应。 */
export const SETTING_KEYS = {
  /** 快捕热键的加速键字符串，如 `"Alt+Space"` */
  captureHotkey: 'hotkey.capture',
  /** macOS 是否隐藏 Dock 图标，`"true"` / `"false"` */
  hideDockIcon: 'macos.hide_dock_icon',
  /** 是否开机自启，`"true"` / `"false"` */
  autostart: 'startup.autostart',
} as const

/** `get_settings` 的原始返回：键有序，值一律字符串。 */
export type SettingsMap = Record<string, string>

/**
 * 把设置值读成 bool。
 *
 * **只有恰好等于 `"true"` 才算真**，这是刻意跟 Rust 的 `settings::read_bool` 保持
 * 一模一样的宽松度（它也是 `value == "true"`）：这边要是多认了 `"True"` / `"1"`，
 * 设置页会显示「已开启」而外壳启动时按 false 处理，两边说法不一致比直接报错更难查。
 * 缺键、空串、认不出的值一律 false——三个 bool 开关的默认状态都是「关」。
 */
export function readBool(settings: SettingsMap, key: string): boolean {
  return readRaw(settings, key) === 'true'
}

/** bool 写回设置表用的字符串形式，和 Rust 的 `settings::write_bool` 成对。 */
export function writeBool(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false'
}

/** macOS 上的默认快捕热键（对应 Rust `shortcut::capture_hotkey` 的 ALT + Space）。 */
export const MAC_DEFAULT_CAPTURE_HOTKEY = 'Alt+Space'
/** 非 macOS 的默认快捕热键（CONTROL|ALT + Space）。 */
export const DEFAULT_CAPTURE_HOTKEY = 'Ctrl+Alt+Space'

/** 平台默认的快捕热键。设置表里没有 `hotkey.capture` 时实际生效的就是它。 */
export function defaultCaptureHotkey(mac: boolean): string {
  return mac ? MAC_DEFAULT_CAPTURE_HOTKEY : DEFAULT_CAPTURE_HOTKEY
}

export interface CaptureHotkeySetting {
  /** 当前实际生效的加速键字符串 */
  accelerator: string
  /** true = 设置表里没有值，用的是平台默认键 */
  isDefault: boolean
}

/**
 * 读快捕热键。
 *
 * 缺键（以及空串、纯空白——外壳的 `shortcut::resolve` 会 trim 后按「没配置」处理）
 * 时返回平台默认键而不是空字符串：设置页显示空的话，用户会以为「还没有热键」，
 * 可实际上 ⌥Space 好好地注册着。
 *
 * 注意这里**不**判断值是否合法：外壳解析不了会退回默认键，但那是启动时的运行时行为，
 * 前端无从得知（没有查询接口）。库里存着什么就显示什么，至少和「下次启动会尝试的值」一致。
 */
export function readCaptureHotkey(settings: SettingsMap, mac: boolean): CaptureHotkeySetting {
  const raw = readRaw(settings, SETTING_KEYS.captureHotkey).trim()
  if (raw.length === 0) return { accelerator: defaultCaptureHotkey(mac), isDefault: true }
  return { accelerator: raw, isDefault: false }
}

/** 设置面板需要的全部状态，由一次 `get_settings` 推出来。 */
export interface AppSettings {
  captureHotkey: string
  /** 热键是平台默认值（设置表里没存过） */
  captureHotkeyIsDefault: boolean
  hideDockIcon: boolean
  autostart: boolean
}

/** 把 `get_settings` 的原始 map 解释成设置面板的状态。 */
export function parseSettings(settings: SettingsMap, mac: boolean): AppSettings {
  const hotkey = readCaptureHotkey(settings, mac)
  return {
    captureHotkey: hotkey.accelerator,
    captureHotkeyIsDefault: hotkey.isDefault,
    hideDockIcon: readBool(settings, SETTING_KEYS.hideDockIcon),
    autostart: readBool(settings, SETTING_KEYS.autostart),
  }
}

/**
 * 取一个键的原始值。
 *
 * 单独抽出来是因为 tsconfig 没开 `noUncheckedIndexedAccess`：`settings[key]` 的静态
 * 类型是 string，缺键时却是 undefined，直接 `.trim()` 会在运行时炸掉。
 */
function readRaw(settings: SettingsMap, key: string): string {
  const value: string | undefined = settings[key]
  return value ?? ''
}
