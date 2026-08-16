import { describe, expect, it } from 'vitest'

import {
  AI_API_KEY_SET,
  DEFAULT_CAPTURE_HOTKEY,
  MAC_DEFAULT_CAPTURE_HOTKEY,
  SETTING_KEYS,
  defaultCaptureHotkey,
  parseAiSettings,
  parseProvider,
  parseSettings,
  readBool,
  readCaptureHotkey,
  writeBool,
} from './settings'

describe('SETTING_KEYS', () => {
  // 这些字符串是白名单，写错一个字母 set_setting 会直接报错，
  // 而 get_settings 那边则是安静地读到 undefined。钉死。
  it('和 Rust 侧的 ALLOWED_KEYS 逐字一致', () => {
    expect(SETTING_KEYS).toEqual({
      captureHotkey: 'hotkey.capture',
      hideDockIcon: 'macos.hide_dock_icon',
      autostart: 'startup.autostart',
      aiEnabled: 'ai.enabled',
      aiProvider: 'ai.provider',
      aiBaseUrl: 'ai.base_url',
      aiApiKey: 'ai.api_key',
      aiChatModel: 'ai.chat_model',
      aiEmbedModel: 'ai.embed_model',
      aiTopK: 'ai.top_k',
    })
  })

  // 合成键混进白名单的话，一次「保存」就会顺手写它，而外壳会拒——
  // 用户看到的是一句莫名其妙的「不认识的设置项」。
  it('合成的 ai.api_key_set 不在白名单里', () => {
    expect(AI_API_KEY_SET).toBe('ai.api_key_set')
    expect(Object.values(SETTING_KEYS)).not.toContain(AI_API_KEY_SET)
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
  // 对应 crates/shell/src/shortcut.rs 的 capture_hotkey()：mac 是 ALT+Space，
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

describe('parseProvider', () => {
  // Rust 的 Provider::parse 是 `"ollama" => Ollama, _ => OpenAi`。
  // 这边多认一种写法，界面显示 Ollama 而外壳按 OpenAI 发请求，两边永远对不上。
  it('只有恰好 "ollama" 是 Ollama', () => {
    expect(parseProvider('ollama')).toBe('ollama')
    for (const value of ['Ollama', 'OLLAMA', ' ollama', 'ollama ', 'openai', '', '本地']) {
      expect(parseProvider(value), value).toBe('openai')
    }
  })
})

describe('parseAiSettings', () => {
  // 缺键必须落在「OpenAI + 什么都没填 + 没有密钥」上：这正是全新安装的样子，
  // 设置页据此显示「未配置」而不是一堆 undefined。
  it('全空的设置表 = openai + 空字段 + 密钥未设置', () => {
    expect(parseAiSettings({})).toEqual({
      provider: 'openai',
      baseUrl: '',
      chatModel: '',
      embedModel: '',
      apiKeySet: false,
    })
  })

  it('读全套 AI 设置', () => {
    expect(
      parseAiSettings({
        'ai.provider': 'ollama',
        'ai.base_url': 'http://localhost:11434',
        'ai.chat_model': 'qwen3',
        'ai.embed_model': 'bge-m3',
        'ai.api_key_set': 'true',
      }),
    ).toEqual({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      chatModel: 'qwen3',
      embedModel: 'bge-m3',
      apiKeySet: true,
    })
  })

  // 密钥本身永远不会回到前端（外壳把 ai.api_key 剔除后合成 ai.api_key_set）。
  // 这条钉住「表单不会去读密钥原文」——真读到了说明外壳的脱敏破了。
  it('只看合成键 ai.api_key_set，不看 ai.api_key', () => {
    const parsed = parseAiSettings({ 'ai.api_key': 'sk-real-secret' })
    expect(parsed.apiKeySet).toBe(false)
    expect(Object.values(parsed)).not.toContain('sk-real-secret')
  })
})
