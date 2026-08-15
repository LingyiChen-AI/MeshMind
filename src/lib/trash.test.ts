import { describe, expect, it } from 'vitest'

import {
  ATTACHMENT_GC_HINT,
  confirmLabel,
  nextConfirmState,
  purgedAllMessage,
  purgedOneMessage,
} from './trash'

describe('purgedOneMessage', () => {
  it('带上标题和附件回收说明', () => {
    const msg = purgedOneMessage('周报')
    expect(msg).toContain('《周报》')
    expect(msg).toContain(ATTACHMENT_GC_HINT)
  })

  it('空标题显示「无标题」', () => {
    expect(purgedOneMessage('   ')).toContain('《无标题》')
  })
})

describe('purgedAllMessage', () => {
  it('报出条数并提示附件延迟回收', () => {
    const msg = purgedAllMessage(3)
    expect(msg).toContain('3 条')
    expect(msg).toContain(ATTACHMENT_GC_HINT)
  })

  it('0 条时不说「删除 0 条」', () => {
    expect(purgedAllMessage(0)).toBe('回收站本来就是空的')
    expect(purgedAllMessage(-1)).toBe('回收站本来就是空的')
  })
})

describe('nextConfirmState', () => {
  it('第一次点击只是武装，不执行', () => {
    expect(nextConfirmState('idle', 'arm')).toBe('armed')
  })

  it('取消回到 idle', () => {
    expect(nextConfirmState('armed', 'cancel')).toBe('idle')
    expect(nextConfirmState('idle', 'cancel')).toBe('idle')
  })

  it('已武装状态下再次 arm 落回 idle（执行后必须复位）', () => {
    expect(nextConfirmState('armed', 'arm')).toBe('idle')
  })
})

describe('confirmLabel', () => {
  it('武装后的文案明确写出不可恢复', () => {
    expect(confirmLabel('idle')).toBe('清空回收站')
    expect(confirmLabel('armed')).toContain('不可恢复')
  })
})
