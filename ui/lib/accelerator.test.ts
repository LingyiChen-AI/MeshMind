import { describe, expect, it } from 'vitest'

import {
  type KeyStroke,
  acceleratorFromEvent,
  formatAccelerator,
  keyDisplayName,
  mainKeyName,
  parseAccelerator,
} from './accelerator'

/** 造一次按键。默认不带任何修饰键。 */
function stroke(code: string, mods: Partial<Omit<KeyStroke, 'code'>> = {}): KeyStroke {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  }
}

/** 取出 ok 分支的字符串，其它分支直接让测试失败（比 as 断言更早暴露问题）。 */
function accel(s: KeyStroke, mac = true): string {
  const outcome = acceleratorFromEvent(s, mac)
  if (outcome.kind !== 'ok') throw new Error(`期望录到热键，实际是 ${outcome.kind}`)
  return outcome.accelerator
}

describe('mainKeyName', () => {
  it('字母和数字取裸写法', () => {
    expect(mainKeyName('KeyA')).toBe('A')
    expect(mainKeyName('KeyZ')).toBe('Z')
    expect(mainKeyName('Digit0')).toBe('0')
    expect(mainKeyName('Digit9')).toBe('9')
  })

  it('功能键和有名字的键原样保留', () => {
    for (const code of ['F1', 'F12', 'F24', 'Space', 'Enter', 'Tab', 'ArrowUp', 'PageDown']) {
      expect(mainKeyName(code), code).toBe(code)
    }
  })

  it('标点键翻成字面量', () => {
    expect(mainKeyName('Backquote')).toBe('`')
    expect(mainKeyName('BracketLeft')).toBe('[')
    expect(mainKeyName('Slash')).toBe('/')
    expect(mainKeyName('Minus')).toBe('-')
    expect(mainKeyName('Quote')).toBe("'")
  })

  // 认不出的键位必须在这里就打回，不能原样塞进加速键去赌外壳认识：
  // 那样用户会先看到「已修改」，再看到一句 Rust 的解析错误。
  it('认不出的键位返回 null', () => {
    for (const code of ['NumpadEnter', 'Numpad1', 'F25', 'KeyÄ', 'Unidentified', '', 'Escape']) {
      expect(mainKeyName(code), code).toBeNull()
    }
  })
})

describe('acceleratorFromEvent', () => {
  it('只按修饰键时什么都不产出（等用户按主键，不该报错）', () => {
    for (const code of ['ControlLeft', 'AltRight', 'ShiftLeft', 'MetaLeft', 'CapsLock']) {
      expect(acceleratorFromEvent(stroke(code, { ctrlKey: true }), true), code).toEqual({
        kind: 'modifiers-only',
      })
    }
  })

  it('修饰键 + 主键', () => {
    expect(accel(stroke('Space', { altKey: true }))).toBe('Alt+Space')
    // Shift 排在 Command 前面：规范顺序就是 macOS 官方的 ⌃⌥⇧⌘
    expect(accel(stroke('KeyK', { metaKey: true, shiftKey: true }))).toBe('Shift+Command+K')
    expect(accel(stroke('Digit1', { ctrlKey: true, altKey: true }))).toBe('Control+Alt+1')
  })

  // 顺序必须只由规范顺序决定，不受按下先后影响——同一个组合按两次得到的字符串
  // 不一样的话，设置页会显示出两个「不同」的热键。
  it('修饰键按规范顺序输出：Control → Alt → Shift → Command', () => {
    const all = { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }
    expect(accel(stroke('KeyK', all))).toBe('Control+Alt+Shift+Command+K')
    expect(accel(stroke('KeyK', all), false)).toBe('Control+Alt+Shift+Super+K')
  })

  // Windows / Linux 上没有 Command 键，写 Super 才是外壳文档里的当地叫法。
  it('非 mac 上的 Meta 写成 Super', () => {
    expect(accel(stroke('KeyK', { metaKey: true }), false)).toBe('Super+K')
  })

  it('认不出的键位被拒，且说清是哪个键', () => {
    const outcome = acceleratorFromEvent(stroke('NumpadEnter', { ctrlKey: true }), true)
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') expect(outcome.message).toContain('NumpadEnter')
  })

  // 全局热键抢在所有应用之前生效：一个裸 K（甚至 Shift+K）会把日常打字吞掉，
  // 而用户几乎不可能把「在别的应用里打字弹出快捕」联想到这个设置。
  it('没有 Ctrl / Alt / Command 时拒绝，Shift 不算数', () => {
    for (const mods of [{}, { shiftKey: true }]) {
      const outcome = acceleratorFromEvent(stroke('KeyK', mods), true)
      expect(outcome.kind, JSON.stringify(mods)).toBe('rejected')
    }
    expect(acceleratorFromEvent(stroke('KeyK', { ctrlKey: true }), true).kind).toBe('ok')
    expect(acceleratorFromEvent(stroke('KeyK', { altKey: true }), true).kind).toBe('ok')
    expect(acceleratorFromEvent(stroke('KeyK', { metaKey: true }), true).kind).toBe('ok')
  })

  // 录出来的东西必须能被自己的解析器认回去——这是「外壳能不能解析」最接近的近似。
  it('录出来的字符串都能解析回同一个组合', () => {
    const cases: KeyStroke[] = [
      stroke('Space', { altKey: true }),
      stroke('KeyK', { ctrlKey: true, shiftKey: true }),
      stroke('Backquote', { metaKey: true }),
      stroke('F5', { ctrlKey: true }),
      stroke('ArrowUp', { ctrlKey: true, altKey: true }),
    ]
    for (const s of cases) {
      const parsed = parseAccelerator(accel(s), true)
      expect(parsed, s.code).not.toBeNull()
      expect(parsed?.key).toBe(mainKeyName(s.code))
    }
  })
})

describe('parseAccelerator', () => {
  it('大小写不敏感（外壳也是）', () => {
    expect(parseAccelerator('ctrl+shift+k', true)).toEqual({ mods: ['Control', 'Shift'], key: 'k' })
  })

  it('认全部修饰键别名', () => {
    expect(parseAccelerator('Option+Space', true)?.mods).toEqual(['Alt'])
    expect(parseAccelerator('Opt+Space', true)?.mods).toEqual(['Alt'])
    expect(parseAccelerator('Cmd+Space', true)?.mods).toEqual(['Command'])
    expect(parseAccelerator('Super+Space', true)?.mods).toEqual(['Command'])
  })

  // CommandOrControl 是跨平台写法，两个平台落到不同的实际修饰键上。
  it('CommandOrControl 按平台落地', () => {
    expect(parseAccelerator('CommandOrControl+K', true)?.mods).toEqual(['Command'])
    expect(parseAccelerator('CmdOrCtrl+K', false)?.mods).toEqual(['Control'])
  })

  it('修饰键排成规范顺序，重复的合并', () => {
    expect(parseAccelerator('Shift+Ctrl+Alt+K', true)?.mods).toEqual(['Control', 'Alt', 'Shift'])
    expect(parseAccelerator('Ctrl+Control+K', true)?.mods).toEqual(['Control'])
  })

  // 这些外壳也解析不了。装作认得的话，显示名会是一个不存在的键。
  it('写法有问题时返回 null', () => {
    for (const raw of ['', '   ', 'Ctrl+', '+K', 'Ctrl++K', 'Nope+K', 'Ctrl+Shift']) {
      expect(parseAccelerator(raw, true), JSON.stringify(raw)).toBeNull()
    }
  })

  it('单独一个主键也能解析（虽然录不出来）', () => {
    expect(parseAccelerator('Space', true)).toEqual({ mods: [], key: 'Space' })
  })
})

describe('keyDisplayName', () => {
  it('KeyA / Digit1 这类写法显示成裸字符', () => {
    expect(keyDisplayName('KeyA')).toBe('A')
    expect(keyDisplayName('Digit1')).toBe('1')
    expect(keyDisplayName('k')).toBe('K')
  })

  it('其余原样（Space 就该显示成 Space）', () => {
    expect(keyDisplayName('Space')).toBe('Space')
    expect(keyDisplayName('F5')).toBe('F5')
    expect(keyDisplayName('`')).toBe('`')
  })
})

describe('formatAccelerator', () => {
  it('mac 用符号连写', () => {
    expect(formatAccelerator('Alt+Space', true)).toBe('⌥Space')
    expect(formatAccelerator('Command+Shift+K', true)).toBe('⇧⌘K')
    expect(formatAccelerator('Control+Alt+Shift+Command+K', true)).toBe('⌃⌥⇧⌘K')
  })

  it('非 mac 用 Ctrl 系写法', () => {
    expect(formatAccelerator('Ctrl+Alt+Space', false)).toBe('Ctrl+Alt+Space')
    expect(formatAccelerator('Super+K', false)).toBe('Win+K')
  })

  it('输入的写法再怎么随意，显示都规范化', () => {
    expect(formatAccelerator('shift+cmd+keyk', true)).toBe('⇧⌘K')
    expect(formatAccelerator('  cmdorctrl+shift+k  ', false)).toBe('Ctrl+Shift+K')
  })

  // 设置表里的值可能是手工改进去的。解析不了也要显示点什么——
  // 显示空白会让用户以为热键没了，而这个面板正是他唯一的修复入口。
  it('解析不了就原样显示，绝不返回空', () => {
    expect(formatAccelerator('Ctrl+K+Shift', true)).toBe('Ctrl+K+Shift')
    expect(formatAccelerator(' 乱写的 ', true)).toBe('乱写的')
  })
})
