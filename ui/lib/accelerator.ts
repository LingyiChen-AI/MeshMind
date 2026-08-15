// 加速键字符串：KeyboardEvent → 字符串（录制），以及字符串 → 给人看的显示名。
//
// 语法由外壳侧的 `global-hotkey`（`Shortcut::from_str`）定义，见
// crates/shell/src/shortcut.rs 的 ACCELERATOR_SYNTAX：
//   - `+` 连接，**修饰键必须全排在主键前面，且只能有一个主键**（`Ctrl+Shift+K` 合法，
//     `Ctrl+K+Shift` 不合法）
//   - 大小写不敏感
//   - 修饰键：Control/Ctrl、Alt/Option、Shift、Command/Cmd/Super、CommandOrControl/CmdOrCtrl
//   - 主键：`KeyA`~`KeyZ` 或裸字母、`Digit0`~`Digit9` 或裸数字、Space/Enter/Tab/…、F1~、
//     以及 ` \ [ ] , . ; / - = ' 的字面量
//
// 这份转换值得单独测，因为它错了没人会立刻发现：产出一个外壳解析不了的字符串，
// 症状是「点了修改，弹一句看不懂的解析错误」；产出一个能解析但不是用户按的键，
// 症状是「热键改了，但按下去没反应」——两者都得回到源码里才能查清。
//
// 只依赖 KeyboardEvent 的 `code`（物理键位）而不是 `key`：`key` 受输入法、键盘布局和
// Shift 影响（按 Shift+2 时 `key` 是 `@`，法语布局上 `key` 又是别的字符），
// 而外壳注册的是物理键位——用 `key` 会让「显示的键」和「实际生效的键」在非美式布局上分家。

/** 录制时只需要这几个字段，写成结构体方便直接喂假事件做单测。 */
export interface KeyStroke {
  /** KeyboardEvent.code，物理键位，如 `KeyK` / `Space` / `Backquote` */
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export type CaptureOutcome =
  /** 只按下了修饰键，等用户继续按主键——不是错误，界面上不该报红 */
  | { kind: 'modifiers-only' }
  /** 这个组合不能用，message 是给用户看的中文原因 */
  | { kind: 'rejected'; message: string }
  | { kind: 'ok'; accelerator: string }

/** 单独按下时不构成主键的键位（按住它们等于「还没按完」）。 */
const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'CapsLock',
])

/** 有名字的主键，名字原样就是外壳认的写法。 */
const NAMED_KEYS = new Set([
  'Space',
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
])

/** 标点键：外壳认字面量，字面量也比 `Backquote` 这种名字好认。 */
const PUNCTUATION: Record<string, string> = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  Quote: "'",
}

/**
 * 把物理键位翻成加速键里的主键名，认不出返回 null。
 *
 * 认不出就拒绝，而不是把 code 原样塞进去赌外壳能认：塞进去的话，
 * 一个 `NumpadEnter` 会一路走到 `set_capture_hotkey` 才被解析器打回来，
 * 而那时用户已经以为自己改成功了。
 */
export function mainKeyName(code: string): string | null {
  // 裸字母 / 裸数字比 KeyA / Digit1 好认，外壳两种写法都收。
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  if (NAMED_KEYS.has(code)) return code
  return PUNCTUATION[code] ?? null
}

/**
 * 修饰键的规范顺序：Control → Alt → Shift → Command。
 *
 * 顺序本身外壳不在乎（解析器只要求修饰键都排在主键前面），但显示要稳定：
 * 同一个组合按两次得到同一个字符串，否则设置页会因为按键先后不同而显示出
 * 两个「不一样」的热键，用户会以为改了个别的东西。这个顺序也正是 macOS 上
 * ⌃⌥⇧⌘ 的官方书写顺序。
 */
const MODIFIER_ORDER = ['Control', 'Alt', 'Shift', 'Command'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

/**
 * 一次按键 → 加速键字符串。
 *
 * 规则里唯一带主张的一条：**必须至少带 Control / Alt / Command 之一**。
 * 全局热键是抢在所有应用之前生效的，光一个 `K` 或者 `Shift+K` 会把日常打字里
 * 的这个键整个吞掉——用户在别的应用里敲一个字母就弹出快捕窗口，而且很难联想到
 * 是这里设错了。宁可在这里挡掉。
 */
export function acceleratorFromEvent(stroke: KeyStroke, mac: boolean): CaptureOutcome {
  if (MODIFIER_CODES.has(stroke.code)) return { kind: 'modifiers-only' }

  const key = mainKeyName(stroke.code)
  if (key === null) {
    return {
      kind: 'rejected',
      message: `这个键（${stroke.code || '未知键位'}）不能用作热键，换字母、数字、F 键或空格试试`,
    }
  }
  if (!stroke.ctrlKey && !stroke.altKey && !stroke.metaKey) {
    return {
      kind: 'rejected',
      message: `热键至少要带 ${mac ? 'Control / Option / Command' : 'Ctrl / Alt'} 之一（只按 ${
        stroke.shiftKey ? 'Shift+' : ''
      }${key} 会把平时打字用的这个键全局吞掉）`,
    }
  }

  const mods: Modifier[] = []
  if (stroke.ctrlKey) mods.push('Control')
  if (stroke.altKey) mods.push('Alt')
  if (stroke.shiftKey) mods.push('Shift')
  if (stroke.metaKey) mods.push('Command')

  return { kind: 'ok', accelerator: [...mods.map((m) => modifierToken(m, mac)), key].join('+') }
}

/** 写进设置里的修饰键名。Windows / Linux 上没有 Command 这个键，写 Super 才是当地叫法。 */
function modifierToken(mod: Modifier, mac: boolean): string {
  if (mod === 'Command') return mac ? 'Command' : 'Super'
  return mod
}

/** 修饰键的各种别名 → 规范名。外壳大小写不敏感，所以这里统一按小写查。 */
const MODIFIER_ALIASES: Record<string, Modifier | 'CommandOrControl'> = {
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
  command: 'Command',
  cmd: 'Command',
  super: 'Command',
  meta: 'Command',
  win: 'Command',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
}

export interface ParsedAccelerator {
  mods: Modifier[]
  key: string
}

/**
 * 解析一个加速键字符串，解析不了返回 null。
 *
 * 「解析不了」是常态而非异常：设置表里的值可能是上个版本写的、也可能是用户手工
 * 改库改进去的。调用方（`formatAccelerator`）遇到 null 会原样显示，绝不能因此崩掉
 * 整个设置面板——那会让用户连改回来的入口都没有。
 */
export function parseAccelerator(raw: string, mac: boolean): ParsedAccelerator | null {
  const tokens = raw
    .trim()
    .split('+')
    .map((token) => token.trim())
  // 空 token 说明写法有问题（`Ctrl+`、`Ctrl++A`）。注意 `+` 自己不是合法主键，
  // 所以不用担心误伤。
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) return null

  const key = tokens[tokens.length - 1] as string
  const mods: Modifier[] = []
  for (const token of tokens.slice(0, -1)) {
    const alias = MODIFIER_ALIASES[token.toLowerCase()]
    if (alias === undefined) return null // 修饰键位上出现了不认识的东西
    const mod: Modifier = alias === 'CommandOrControl' ? (mac ? 'Command' : 'Control') : alias
    if (!mods.includes(mod)) mods.push(mod)
  }
  // 主键位上出现修饰键（`Ctrl+Shift`）：外壳也解析不了，别装作认得。
  if (MODIFIER_ALIASES[key.toLowerCase()] !== undefined) return null

  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  return { mods, key }
}

const MAC_SYMBOLS: Record<Modifier, string> = {
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Command: '⌘',
}

const PC_NAMES: Record<Modifier, string> = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Command: 'Win',
}

/** 主键的显示名：`KeyA` → `A`，`Digit1` → `1`，其余原样（`Space` 就该显示成 Space）。 */
export function keyDisplayName(key: string): string {
  const letter = /^Key([A-Z])$/i.exec(key)
  if (letter) return (letter[1] as string).toUpperCase()
  const digit = /^Digit([0-9])$/i.exec(key)
  if (digit) return digit[1] as string
  if (/^[a-z]$/.test(key)) return key.toUpperCase()
  return key
}

/**
 * 给人看的热键显示名。
 *
 * mac 用符号连写（⌥Space），其它平台用 `Ctrl+Alt+Space`——这跟 lib/platform.ts 里
 * 那组固定文案是同一套习惯，只是这里的来源是设置值而不是写死的常量。
 *
 * 解析不了就原样返回 trim 过的输入：显示一个奇怪的字符串，好过显示空白让用户
 * 以为热键没了。
 */
export function formatAccelerator(raw: string, mac: boolean): string {
  const parsed = parseAccelerator(raw, mac)
  const trimmed = raw.trim()
  if (parsed === null) return trimmed
  const key = keyDisplayName(parsed.key)
  return mac
    ? parsed.mods.map((mod) => MAC_SYMBOLS[mod]).join('') + key
    : [...parsed.mods.map((mod) => PC_NAMES[mod]), key].join('+')
}
