import { describe, expect, it } from 'vitest'

import { type ActiveOverlay, closeOverlay, toggleOverlay } from './overlay'

const LAYERS = ['search', 'trash', 'settings'] as const

describe('toggleOverlay', () => {
  it('没开时打开', () => {
    for (const layer of LAYERS) {
      expect(toggleOverlay(null, layer), layer).toBe(layer)
    }
  })

  it('再点同一层就关掉（⌘K 的开关语义）', () => {
    for (const layer of LAYERS) {
      expect(toggleOverlay(layer, layer), layer).toBeNull()
    }
  })

  // 三个面板都是全屏遮罩，不叠层：开着回收站时按 ⌘K，用户要的是搜索，
  // 而不是「先按 Esc 关掉回收站再按一次」。
  it('开着别的层时直接换过去，不叠层', () => {
    expect(toggleOverlay('trash', 'search')).toBe('search')
    expect(toggleOverlay('settings', 'search')).toBe('search')
    expect(toggleOverlay('search', 'settings')).toBe('settings')
  })
})

describe('closeOverlay', () => {
  it('关掉当前这一层', () => {
    for (const layer of LAYERS) {
      expect(closeOverlay(layer, layer), layer).toBeNull()
    }
  })

  // onClose 可能来自异步回调（回收站恢复成功之后才关），那时前台可能已经换层了。
  // 无条件置 null 会把用户刚打开的面板关掉。
  it('当前不是这一层时保持原样', () => {
    expect(closeOverlay('settings', 'trash')).toBe('settings')
    expect(closeOverlay('search', 'trash')).toBe('search')
  })

  it('本来就没开着的时候是空操作', () => {
    const closed: ActiveOverlay = null
    expect(closeOverlay(closed, 'search')).toBeNull()
  })
})
