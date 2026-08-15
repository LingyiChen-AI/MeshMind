import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CAPTURE_HOTKEY,
  MAC_DEFAULT_CAPTURE_HOTKEY,
  SETTING_KEYS,
  defaultCaptureHotkey,
  parseSettings,
  readBool,
  readCaptureHotkey,
  writeBool,
} from './settings'

describe('SETTING_KEYS', () => {
  // 这三个字符串是白名单，写错一个字母 set_setting 会直接报错，
  // 而 get_settings 那边则是安静地读到 undefined。钉死。
  it('和 Rust 侧的 ALLOWED_KEYS 逐字一致', () => {
    expect(SETTING_KEYS).toEqual({
      captureHotkey: 'hotkey.capture',
      hideDockIcon: 'macos.hide_dock_icon',
      autostart: 'startup.autostart',
    })
  })
})

describe('readBool', () => {
  it('只有恰好 "true" 才是真', () => {
    expect(readBool({ k: 'true' }, 'k')).toBe(true)
    expect(readBool({ k: 'false' }, 'k')).toBe(false)
  })

  it('缺键按 false（三个开关的默认状态都是关）', () => {
    expect(readBool({}, 'k')).toBe(false)
  })

  // 这几个「看起来像真」的值 Rust 侧一律按 false 处理，前端多认一个都会造成
  // 「设置页说开着、下次启动却是关的」这种最难查的不一致。
  it('"True" / "1" / "yes" / 空串都按 false，与 Rust 的 read_bool 同宽松度', () => {
    for (const value of ['True', 'TRUE', '1', 'yes', 'on', '', ' true']) {
      expect(readBool({ k: value }, 'k'), value).toBe(false)
    }
  })
})

describe('writeBool', () => {
  it('写回去的就是 Rust 认的那两个字面量', () => {
    expect(writeBool(true)).toBe('true')
    expect(writeBool(false)).toBe('false')
  })

  it('和 readBool 往返一致', () => {
    for (const value of [true, false]) {
      expect(readBool({ k: writeBool(value) }, 'k')).toBe(value)
    }
  })
})

describe('defaultCaptureHotkey', () => {
  // 对应 src-tauri/src/shortcut.rs 的 capture_hotkey()：mac 是 ALT+Space，
  // 其余平台是 CONTROL|ALT+Space。
  it('按平台给出外壳实际注册的那个键', () => {
    expect(defaultCaptureHotkey(true)).toBe(MAC_DEFAULT_CAPTURE_HOTKEY)
    expect(defaultCaptureHotkey(true)).toBe('Alt+Space')
    expect(defaultCaptureHotkey(false)).toBe(DEFAULT_CAPTURE_HOTKEY)
    expect(defaultCaptureHotkey(false)).toBe('Ctrl+Alt+Space')
  })
})

describe('readCaptureHotkey', () => {
  it('存过就用存的值', () => {
    expect(readCaptureHotkey({ 'hotkey.capture': 'Ctrl+Shift+K' }, true)).toEqual({
      accelerator: 'Ctrl+Shift+K',
      isDefault: false,
    })
  })

  // 没有这个键**不等于**没有热键：外壳这时注册的是平台默认键。
  // 显示空字符串会让用户以为快捕没有热键，然后去设一个，白改。
  it('缺键时给出平台默认键而不是空', () => {
    expect(readCaptureHotkey({}, true)).toEqual({ accelerator: 'Alt+Space', isDefault: true })
    expect(readCaptureHotkey({}, false)).toEqual({
      accelerator: 'Ctrl+Alt+Space',
      isDefault: true,
    })
  })

  // 外壳的 resolve() 是 trim 之后再判空的，空白值同样退回默认键。
  it('空串和纯空白也算没配置', () => {
    for (const raw of ['', '   ', '\t']) {
      expect(readCaptureHotkey({ 'hotkey.capture': raw }, true).isDefault, raw).toBe(true)
    }
  })

  it('值两侧的空白会被去掉（外壳存之前也 trim）', () => {
    expect(readCaptureHotkey({ 'hotkey.capture': '  Alt+K ' }, true).accelerator).toBe('Alt+K')
  })
})

describe('parseSettings', () => {
  it('全空的设置表 = 平台默认键 + 两个开关都关', () => {
    expect(parseSettings({}, true)).toEqual({
      captureHotkey: 'Alt+Space',
      captureHotkeyIsDefault: true,
      hideDockIcon: false,
      autostart: false,
    })
  })

  it('读全套设置', () => {
    expect(
      parseSettings(
        {
          'hotkey.capture': 'Command+Shift+Space',
          'macos.hide_dock_icon': 'true',
          'startup.autostart': 'false',
        },
        true,
      ),
    ).toEqual({
      captureHotkey: 'Command+Shift+Space',
      captureHotkeyIsDefault: false,
      hideDockIcon: true,
      autostart: false,
    })
  })

  // 设置表是跨平台同一张：Windows 上也可能存着 macos.hide_dock_icon。
  // 解析照常（渲不渲染那一项由组件按 isMac 决定）。
  it('非 mac 上照样解析 Dock 开关，不报错', () => {
    expect(parseSettings({ 'macos.hide_dock_icon': 'true' }, false).hideDockIcon).toBe(true)
  })
})
